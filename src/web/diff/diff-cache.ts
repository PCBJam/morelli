/**
 * IndexedDB cache for computed diffs, keyed `${baselineSha}:${runSha}`.
 *
 * SAFE BY CONSTRUCTION: both inputs are content-addressed (the baseline via
 * its CAS sha, the run image via the sha in the always-fresh meta.json/diffPlan
 * response), so a cached entry can never be stale — any promote or re-run
 * changes a sha and therefore the key. No revalidation pass is needed.
 *
 * Entries hold the numbers AND the rendered heatmap/boxes PNG blobs (~100KB
 * per changed screenshot), so a revisit skips fetch+decode+pixelmatch
 * entirely. Age-based pruning (run uploads expire from R2 after 30 days
 * anyway) keeps the store bounded. Every operation is best-effort: on any
 * failure (private browsing, quota, corrupted DB) the caller just recomputes.
 */
import type { Box } from '../../shared/cluster';

export type CachedDiff = {
    key: string;
    at: number;
    dimsMatch: boolean;
    changedRatio: number;
    diffPixels: number;
    width: number;
    height: number;
    boxes: Box[];
    heatmapBlob: Blob | null;
    boxesBlob: Blob | null;
};

const DB_NAME = 'morelli-diff-cache';
const STORE = 'diffs';
const PRUNE_AGE_MS = 14 * 24 * 3600 * 1000;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        try {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
                store.createIndex('at', 'at');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
    // One prune per session, off the critical path.
    void dbPromise.then((db) => db && pruneOld(db));
    return dbPromise;
}

function pruneOld(db: IDBDatabase): void {
    try {
        const range = IDBKeyRange.upperBound(Date.now() - PRUNE_AGE_MS);
        const cursorReq = db.transaction(STORE, 'readwrite').objectStore(STORE).index('at').openCursor(range);
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
    } catch {
        /* best effort */
    }
}

export async function cacheGet(key: string): Promise<CachedDiff | null> {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            req.onsuccess = () => resolve((req.result as CachedDiff | undefined) ?? null);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

export async function cachePut(entry: CachedDiff): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry);
    } catch {
        /* quota/private mode — recompute next time */
    }
}
