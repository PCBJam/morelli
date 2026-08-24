import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { s3FromEnv } from '../s3';
import { baselinesManifestKey } from '../../shared/keys';
import { entryId, isPipeline, parseManifest } from '../../shared/schemas';
import type { Manifest } from '../../shared/schemas';
import { deriveEntryHistory } from '../history-logic';

export const baselinesRoutes = new Hono<AppEnv>();

baselinesRoutes.get('/pipelines/:p/baselines', async (c) => {
    const p = c.req.param('p');
    if (!isPipeline(p)) return c.json({ error: `unknown pipeline "${p}"` }, 404);
    const got = await s3FromEnv(c.env).getText(baselinesManifestKey(c.env.BASELINES_PREFIX, p));
    if (!got) return c.json({ error: 'no baseline manifest — run the seed script first' }, 404);
    const manifest = parseManifest(got.text);
    return c.json({
        version: manifest.version,
        updatedAt: manifest.updatedAt,
        updatedBy: manifest.updatedBy,
        etag: got.etag,
        entries: manifest.screenshots,
    });
});

// Bound the per-request snapshot reads (subrequests + latency). Every promote
// snapshots the whole manifest, so 25 snapshots ≥ 25 promotes of lookback —
// usually far more than 10 versions of any single entry.
const SNAPSHOT_READ_CAP = 25;
const ENGINE_RE = /^[a-z][a-z0-9-]*$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/;

baselinesRoutes.get('/pipelines/:p/baselines/history', async (c) => {
    const p = c.req.param('p');
    if (!isPipeline(p)) return c.json({ error: `unknown pipeline "${p}"` }, 404);
    const engine = c.req.query('engine') ?? '';
    const name = c.req.query('name') ?? '';
    if (!ENGINE_RE.test(engine) || !NAME_RE.test(name)) return c.json({ error: 'bad engine/name' }, 400);
    const id = `${engine}/${name}`;

    const s3 = s3FromEnv(c.env);
    const currentGot = await s3.getText(baselinesManifestKey(c.env.BASELINES_PREFIX, p));
    const currentEntry = currentGot ? (parseManifest(currentGot.text).screenshots.find((e) => entryId(e) === id) ?? null) : null;

    // Collect every snapshot key (keys embed a sanitized ISO stamp, so
    // lexicographic ascending = chronological) and read only the newest cap.
    const historyPrefix = `${c.env.BASELINES_PREFIX}${p}/history/`;
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
        const page = await s3.list({ prefix: historyPrefix, cursor });
        for (const o of page.objects) keys.push(o.key);
        cursor = page.cursor ?? undefined;
    } while (cursor);
    const newestFirst = keys.slice(-SNAPSHOT_READ_CAP).reverse();

    const snapshots = (
        await Promise.all(
            newestFirst.map(async (key) => {
                try {
                    const got = await s3.getText(key);
                    if (!got) return null;
                    const manifest: Manifest = parseManifest(got.text);
                    return { stamp: key.slice(historyPrefix.length).replace(/\.json$/, ''), manifest };
                } catch (e) {
                    console.warn(`[history] skipping unreadable snapshot ${key}: ${(e as Error).message}`);
                    return null;
                }
            })
        )
    ).filter((s) => s !== null);

    const { versions, stoppedAtAbsence, consumedAll } = deriveEntryHistory(currentEntry, snapshots, id);
    if (versions.length === 0) return c.json({ error: `no baseline "${id}"` }, 404);

    return c.json({
        id,
        versions,
        scannedSnapshots: snapshots.length,
        // The chain's start was NOT seen: either the cap cut the walk short or
        // older snapshots exist beyond the read window.
        truncated: !stoppedAtAbsence && (!consumedAll || keys.length > SNAPSHOT_READ_CAP),
    });
});
