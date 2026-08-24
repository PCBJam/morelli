/**
 * Main-thread facade over the diff worker: one shared worker, a small
 * concurrency gate (image decode is the expensive part), promise-per-request,
 * plus a content-addressed IndexedDB cache (see diff-cache.ts — keys are sha
 * pairs, so hits can never be stale).
 *
 * The worker posts PNG Blobs; object URLs are created HERE (and revoked via
 * revokeDiff) so the whole URL lifecycle lives in the main realm.
 */
import type { Box } from '../../shared/cluster';
import { cacheGet, cachePut } from './diff-cache';
import type { DiffRequest, DiffResponse, DiffSuccess } from './diff.worker';

export type DiffResult = {
    dimsMatch: boolean;
    changedRatio: number;
    diffPixels: number;
    width: number;
    height: number;
    boxes: Box[];
    /** Object URL of pixelmatch's output PNG (the CI heatmap); null on dims mismatch. */
    heatmapUrl: string | null;
    /** Object URL of the run render with red cluster boxes baked in; null when no boxes. */
    boxesUrl: string | null;
};

/** Release a result's object URLs. Safe to call more than once. */
export function revokeDiff(d: DiffResult): void {
    if (d.heatmapUrl) URL.revokeObjectURL(d.heatmapUrl);
    if (d.boxesUrl) URL.revokeObjectURL(d.boxesUrl);
}

const CONCURRENCY = 3;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: DiffSuccess) => void; reject: (e: Error) => void }>();
let inFlight = 0;
const queue: Array<() => void> = [];

function ensureWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (ev: MessageEvent<DiffResponse>) => {
        const entry = pending.get(ev.data.id);
        if (!entry) return;
        pending.delete(ev.data.id);
        inFlight--;
        queue.shift()?.();
        if (ev.data.ok) entry.resolve(ev.data);
        else entry.reject(new Error(ev.data.error));
    });
    return worker;
}

function computeViaWorker(baselineUrl: string, runUrl: string): Promise<DiffSuccess> {
    return new Promise((resolve, reject) => {
        const start = () => {
            inFlight++;
            const id = nextId++;
            pending.set(id, { resolve, reject });
            const req: DiffRequest = { id, baselineUrl, runUrl };
            ensureWorker().postMessage(req);
        };
        if (inFlight < CONCURRENCY) start();
        else queue.push(start);
    });
}

function toResult(d: { dimsMatch: boolean; changedRatio: number; diffPixels: number; width: number; height: number; boxes: Box[]; heatmapBlob: Blob | null; boxesBlob: Blob | null }): DiffResult {
    return {
        dimsMatch: d.dimsMatch,
        changedRatio: d.changedRatio,
        diffPixels: d.diffPixels,
        width: d.width,
        height: d.height,
        boxes: d.boxes,
        heatmapUrl: d.heatmapBlob ? URL.createObjectURL(d.heatmapBlob) : null,
        boxesUrl: d.boxesBlob ? URL.createObjectURL(d.boxesBlob) : null,
    };
}

/**
 * Compute (or recall) the diff of two images. `cacheKey` should be the
 * content-addressed pair `${baselineSha}:${runSha}` — pass it whenever both
 * shas are known and the result becomes durable across visits.
 */
export async function computeDiff(baselineUrl: string, runUrl: string, cacheKey?: string): Promise<DiffResult> {
    if (cacheKey) {
        const hit = await cacheGet(cacheKey);
        if (hit) return toResult(hit);
    }
    const res = await computeViaWorker(baselineUrl, runUrl);
    if (cacheKey) {
        void cachePut({
            key: cacheKey,
            at: Date.now(),
            dimsMatch: res.dimsMatch,
            changedRatio: res.changedRatio,
            diffPixels: res.diffPixels,
            width: res.width,
            height: res.height,
            boxes: res.boxes,
            heatmapBlob: res.heatmapBlob,
            boxesBlob: res.boxesBlob,
        });
    }
    return toResult(res);
}
