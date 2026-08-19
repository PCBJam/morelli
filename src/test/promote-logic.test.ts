import { describe, expect, it } from 'vitest';
import { StaleManifestError, commitPromotion, ensureBlob } from '../worker/promote-logic';
import { MANIFEST_VERSION, serializeManifest } from '../shared/schemas';
import type { Manifest, RunMeta } from '../shared/schemas';
import type { S3 } from '../worker/s3';

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** In-memory S3 double covering the subset promote-logic uses, with real conditional-write semantics. */
class FakeS3 {
    objects = new Map<string, { body: string | ArrayBuffer; etag: string }>();
    private etagSeq = 0;

    seed(key: string, body: string | ArrayBuffer): string {
        const etag = `"etag-${++this.etagSeq}"`;
        this.objects.set(key, { body, etag });
        return etag;
    }

    async head(key: string): Promise<{ ok: boolean; etag: string | null; size: number }> {
        const o = this.objects.get(key);
        return o ? { ok: true, etag: o.etag, size: 1 } : { ok: false, etag: null, size: 0 };
    }

    async getText(key: string): Promise<{ text: string; etag: string | null } | null> {
        const o = this.objects.get(key);
        return o ? { text: typeof o.body === 'string' ? o.body : new TextDecoder().decode(o.body), etag: o.etag } : null;
    }

    async getBytes(key: string): Promise<{ bytes: ArrayBuffer; etag: string | null } | null> {
        const o = this.objects.get(key);
        if (!o) return null;
        const bytes = typeof o.body === 'string' ? new TextEncoder().encode(o.body).buffer : o.body;
        return { bytes: bytes as ArrayBuffer, etag: o.etag };
    }

    async put(key: string, body: string | ArrayBuffer, opts: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<{ status: number; etag: string | null }> {
        const existing = this.objects.get(key);
        if (opts.ifNoneMatch === '*' && existing) return { status: 412, etag: null };
        if (opts.ifMatch && (!existing || existing.etag !== opts.ifMatch)) return { status: 412, etag: null };
        return { status: 200, etag: this.seed(key, body) };
    }

    asS3(): S3 {
        return this as unknown as S3;
    }
}

const RUN_ID = '12345';

function runMeta(shots: Array<{ name: string; engine: string; sha256: string; bytes?: number }>): RunMeta {
    return {
        schemaVersion: 1,
        pipeline: 'pcbjam',
        repo: 'PCBJam/pcbjam',
        runId: RUN_ID,
        runAttempt: 1,
        workflow: 'CI',
        event: 'push',
        branch: 'main',
        prNumber: null,
        commit: 'c'.repeat(40),
        commitSubject: 'test',
        uploadedAt: '2026-08-19T00:00:00.000Z',
        e2e: 'pass',
        screenshots: shots.map((s) => ({ bytes: 5, width: 2, height: 2, ...s })),
    };
}

function baselineManifest(entries: Array<{ name: string; engine: string; sha256: string }>): Manifest {
    return {
        version: MANIFEST_VERSION,
        pipeline: 'pcbjam',
        storage: { bucket: 'pcbjam-ci-screenshots', keyPrefix: 'sha256/' },
        updatedAt: '2026-08-01T00:00:00.000Z',
        updatedBy: 'seed',
        screenshots: entries.map((e) => ({ ...e, bytes: 5, width: 2, height: 2 })),
    };
}

describe('ensureBlob', () => {
    it('uploads verbatim run bytes to the CAS after verifying the sha', async () => {
        const s3 = new FakeS3();
        const body = 'png-bytes';
        const sha = await sha256Hex(body);
        s3.seed(`runs/pcbjam/${RUN_ID}/chromium/a.png`, body);
        expect(await ensureBlob(s3.asS3(), { pipeline: 'pcbjam', runId: RUN_ID, name: 'a.png', engine: 'chromium', sha256: sha })).toBe('uploaded');
        expect(s3.objects.has(`sha256/${sha}.png`)).toBe(true);
        expect(await ensureBlob(s3.asS3(), { pipeline: 'pcbjam', runId: RUN_ID, name: 'a.png', engine: 'chromium', sha256: sha })).toBe('exists');
    });

    it('refuses a sha mismatch — a bad uploader hash must never poison the CAS', async () => {
        const s3 = new FakeS3();
        s3.seed(`runs/pcbjam/${RUN_ID}/chromium/a.png`, 'actual-bytes');
        const wrong = await sha256Hex('other-bytes');
        await expect(ensureBlob(s3.asS3(), { pipeline: 'pcbjam', runId: RUN_ID, name: 'a.png', engine: 'chromium', sha256: wrong })).rejects.toThrow(/sha mismatch/);
        expect(s3.objects.has(`sha256/${wrong}.png`)).toBe(false);
    });

    it('errors when the run object expired', async () => {
        const s3 = new FakeS3();
        await expect(
            ensureBlob(s3.asS3(), { pipeline: 'pcbjam', runId: RUN_ID, name: 'gone.png', engine: 'chromium', sha256: 'a'.repeat(64) })
        ).rejects.toThrow(/run object missing/);
    });
});

describe('commitPromotion', () => {
    const OLD_SHA = '1'.repeat(64);
    const NEW_SHA = '2'.repeat(64);

    function setup() {
        const s3 = new FakeS3();
        const etag = s3.seed('baselines/pcbjam/manifest.json', serializeManifest(baselineManifest([{ name: 'a.png', engine: 'chromium', sha256: OLD_SHA }])));
        s3.seed(`runs/pcbjam/${RUN_ID}/meta.json`, JSON.stringify(runMeta([{ name: 'a.png', engine: 'chromium', sha256: NEW_SHA }, { name: 'b.png', engine: 'chromium', sha256: NEW_SHA }])));
        s3.seed(`sha256/${NEW_SHA}.png`, 'new-bytes'); // blob phase already ran
        return { s3, etag };
    }

    const base = { pipeline: 'pcbjam' as const, runId: RUN_ID, promotedBy: 'user@example.com', baselinesPrefix: 'baselines/' };

    it('updates + adds entries, writes a history snapshot, records provenance', async () => {
        const { s3, etag } = setup();
        const result = await commitPromotion(s3.asS3(), {
            ...base,
            items: [
                { name: 'a.png', engine: 'chromium' },
                { name: 'b.png', engine: 'chromium' },
            ],
            expectedEtag: etag,
        });
        expect(result).toMatchObject({ updated: 1, added: 1, pruned: 0, unchangedSkipped: 0, wrote: true });

        const manifest = JSON.parse((await s3.getText('baselines/pcbjam/manifest.json'))!.text) as Manifest;
        expect(manifest.screenshots).toHaveLength(2);
        const a = manifest.screenshots.find((e) => e.name === 'a.png')!;
        expect(a.sha256).toBe(NEW_SHA);
        expect(a.source).toMatchObject({ kind: 'promoted', runId: RUN_ID, branch: 'main', promotedBy: 'user@example.com' });
        expect(manifest.updatedBy).toBe('user@example.com');

        const historyKeys = [...s3.objects.keys()].filter((k) => k.startsWith('baselines/pcbjam/history/'));
        expect(historyKeys).toHaveLength(1);
        const snapshot = JSON.parse((await s3.getText(historyKeys[0]!))!.text) as Manifest;
        expect(snapshot.screenshots.find((e) => e.name === 'a.png')!.sha256).toBe(OLD_SHA); // the PREVIOUS manifest
    });

    it('409s (StaleManifestError) when the client-loaded etag is stale', async () => {
        const { s3 } = setup();
        await expect(commitPromotion(s3.asS3(), { ...base, items: [{ name: 'a.png', engine: 'chromium' }], expectedEtag: '"someone-else"' })).rejects.toBeInstanceOf(
            StaleManifestError
        );
    });

    it('skips identical shas churn-free (no write, provenance preserved)', async () => {
        const s3 = new FakeS3();
        const etag = s3.seed('baselines/pcbjam/manifest.json', serializeManifest(baselineManifest([{ name: 'a.png', engine: 'chromium', sha256: NEW_SHA }])));
        s3.seed(`runs/pcbjam/${RUN_ID}/meta.json`, JSON.stringify(runMeta([{ name: 'a.png', engine: 'chromium', sha256: NEW_SHA }])));
        const result = await commitPromotion(s3.asS3(), { ...base, items: [{ name: 'a.png', engine: 'chromium' }], expectedEtag: etag });
        expect(result).toMatchObject({ updated: 0, added: 0, unchangedSkipped: 1, wrote: false, newEtag: etag });
        expect([...s3.objects.keys()].some((k) => k.includes('/history/'))).toBe(false);
    });

    it('prunes removed baselines', async () => {
        const { s3, etag } = setup();
        const result = await commitPromotion(s3.asS3(), { ...base, items: [], prune: ['chromium/a.png'], expectedEtag: etag });
        expect(result).toMatchObject({ pruned: 1, wrote: true });
        const manifest = JSON.parse((await s3.getText('baselines/pcbjam/manifest.json'))!.text) as Manifest;
        expect(manifest.screenshots).toHaveLength(0);
    });

    it('refuses to publish a manifest entry whose CAS object is missing', async () => {
        const { s3, etag } = setup();
        s3.objects.delete(`sha256/${NEW_SHA}.png`);
        await expect(commitPromotion(s3.asS3(), { ...base, items: [{ name: 'a.png', engine: 'chromium' }], expectedEtag: etag })).rejects.toThrow(/CAS object missing/);
    });

    it('errors when no manifest is seeded or the run meta is gone', async () => {
        const empty = new FakeS3();
        await expect(commitPromotion(empty.asS3(), { ...base, items: [{ name: 'a.png', engine: 'chromium' }], expectedEtag: '"x"' })).rejects.toThrow(/seed/);

        const s3 = new FakeS3();
        const etag = s3.seed('baselines/pcbjam/manifest.json', serializeManifest(baselineManifest([])));
        await expect(commitPromotion(s3.asS3(), { ...base, items: [{ name: 'a.png', engine: 'chromium' }], expectedEtag: etag })).rejects.toThrow(/no meta\.json/);
    });
});
