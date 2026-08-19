/**
 * The promotion core. Two phases mirror the two API endpoints:
 *
 *  1. ensureBlob — copy a run screenshot's VERBATIM bytes into the CAS
 *     (sha256/<hex>.png). The bytes are re-hashed with crypto.subtle before the
 *     PUT: a wrong sha recorded by a CI uploader must never poison the CAS,
 *     because every CI baseline fetch integrity-checks downloads against the
 *     key and would hard-fail from then on.
 *
 *  2. commitPromotion — one conditional read-modify-write of the pipeline's
 *     baseline manifest. The client sends the etag it loaded; any mismatch
 *     (someone else promoted meanwhile) is surfaced as StaleManifestError →
 *     HTTP 409, and the client refetches. A history snapshot of the previous
 *     manifest is written first, so any promote can be reverted later.
 */
import { casKey, runImageKey, runMetaKey, baselinesManifestKey, baselinesHistoryKey } from '../shared/keys';
import { entryId, parseManifest, parseRunMeta, serializeManifest } from '../shared/schemas';
import type { Manifest, ManifestEntry, Pipeline, RunMeta } from '../shared/schemas';
import type { S3 } from './s3';

export class StaleManifestError extends Error {
    constructor(public currentEtag: string | null) {
        super('baseline manifest changed since it was loaded');
    }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type EnsureBlobInput = { pipeline: Pipeline; runId: string; name: string; engine: string; sha256: string };

/** Ensure `sha256/<sha>.png` exists, sourcing verbatim bytes from the run upload. */
export async function ensureBlob(s3: S3, input: EnsureBlobInput): Promise<'exists' | 'uploaded'> {
    const target = casKey(input.sha256);
    if ((await s3.head(target)).ok) return 'exists';

    const runKey = runImageKey(input.pipeline, input.runId, input.engine, input.name);
    const got = await s3.getBytes(runKey);
    if (!got) throw new Error(`run object missing: ${runKey} (expired or never uploaded)`);
    const actual = await sha256Hex(got.bytes);
    if (actual !== input.sha256) {
        throw new Error(`sha mismatch for ${runKey}: meta says ${input.sha256}, bytes are ${actual}`);
    }
    const put = await s3.put(target, got.bytes, { contentType: 'image/png' });
    if (put.status !== 200) throw new Error(`PUT ${target} → HTTP ${put.status}`);
    return 'uploaded';
}

export type CommitInput = {
    pipeline: Pipeline;
    runId: string;
    /** Screenshots (by identity) to promote from this run. */
    items: Array<{ name: string; engine: string }>;
    /** Baseline entry ids ("<engine>/<name>") to REMOVE (screenshots the suite no longer produces). */
    prune?: string[];
    /** The manifest etag the client loaded — the optimistic-concurrency token. */
    expectedEtag: string;
    promotedBy: string;
    baselinesPrefix: string;
};

export type CommitResult = {
    updated: number;
    added: number;
    pruned: number;
    unchangedSkipped: number;
    newEtag: string | null;
    wrote: boolean;
};

export async function commitPromotion(s3: S3, input: CommitInput): Promise<CommitResult> {
    const manifestKey = baselinesManifestKey(input.baselinesPrefix, input.pipeline);
    const current = await s3.getText(manifestKey);
    if (!current) throw new Error(`no baseline manifest at ${manifestKey} — run the seed script first`);
    if (current.etag !== input.expectedEtag) throw new StaleManifestError(current.etag);
    const manifest: Manifest = parseManifest(current.text);

    const metaText = await s3.getText(runMetaKey(input.pipeline, input.runId));
    if (!metaText) throw new Error(`run ${input.runId} has no meta.json (upload incomplete or expired)`);
    const meta: RunMeta = parseRunMeta(metaText.text);
    const metaById = new Map(meta.screenshots.map((s) => [entryId(s), s]));

    const entries = new Map(manifest.screenshots.map((e) => [entryId(e), e]));
    const now = new Date().toISOString();
    let updated = 0;
    let added = 0;
    let unchangedSkipped = 0;

    for (const item of input.items) {
        const id = entryId(item);
        const shot = metaById.get(id);
        if (!shot) throw new Error(`run ${input.runId} has no screenshot "${id}"`);
        const existing = entries.get(id);
        if (existing && existing.sha256 === shot.sha256) {
            unchangedSkipped++; // churn-free: identical bytes keep their provenance
            continue;
        }
        // The blob phase must have run first; a missing CAS object here would
        // publish a manifest whose baselines cannot be fetched.
        if (!(await s3.head(casKey(shot.sha256))).ok) {
            throw new Error(`CAS object missing for "${id}" (${shot.sha256}) — blob phase incomplete`);
        }
        const entry: ManifestEntry = {
            name: shot.name,
            engine: shot.engine,
            sha256: shot.sha256,
            bytes: shot.bytes,
            width: shot.width,
            height: shot.height,
            source: {
                kind: 'promoted',
                runId: input.runId,
                branch: meta.branch,
                commit: meta.commit,
                promotedAt: now,
                promotedBy: input.promotedBy,
            },
        };
        if (existing) updated++;
        else added++;
        entries.set(id, entry);
    }

    let pruned = 0;
    for (const id of input.prune ?? []) {
        if (entries.delete(id)) pruned++;
    }

    if (updated + added + pruned === 0) {
        return { updated, added, pruned, unchangedSkipped, newEtag: current.etag, wrote: false };
    }

    // Snapshot the PREVIOUS manifest (verbatim text) before replacing it. A 412
    // here means an identical snapshot key already exists (same second + run) —
    // the content is the same manifest, so it is safe to continue.
    const historyKey = baselinesHistoryKey(input.baselinesPrefix, input.pipeline, now, input.runId);
    const snap = await s3.put(historyKey, current.text, { contentType: 'application/json', ifNoneMatch: '*' });
    if (snap.status !== 200 && snap.status !== 412) throw new Error(`history snapshot PUT → HTTP ${snap.status}`);

    const next: Manifest = {
        ...manifest,
        updatedAt: now,
        updatedBy: input.promotedBy,
        screenshots: [...entries.values()],
    };
    const put = await s3.put(manifestKey, serializeManifest(next), {
        contentType: 'application/json',
        ifMatch: input.expectedEtag,
    });
    if (put.status === 412) throw new StaleManifestError(null);
    return { updated, added, pruned, unchangedSkipped, newEtag: put.etag, wrote: true };
}
