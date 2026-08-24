/**
 * Build listing + run-vs-baseline diff plan.
 *
 * Runs are discovered by a delimiter LIST under runs/<pipeline>/ — run counts
 * are bounded by the 30-day lifecycle rule, so we list all prefixes (1–2 S3
 * pages), sort numerically descending and paginate in memory; the cursor is a
 * plain offset into that ordering.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { s3FromEnv } from '../s3';
import type { S3 } from '../s3';
import { baselinesManifestKey, runMetaKey, runPrefix } from '../../shared/keys';
import { entryId, isPipeline, parseManifest, parseRunMeta } from '../../shared/schemas';
import type { Manifest, ManifestEntry, Pipeline, RunMeta } from '../../shared/schemas';
import { PIPELINES } from '../../shared/schemas';
import { baselineShaMap, liveCounts } from '../live-counts';

export const runsRoutes = new Hono<AppEnv>();

async function loadManifest(s3: S3, prefix: string, pipeline: Pipeline): Promise<{ manifest: Manifest; etag: string | null } | null> {
    const got = await s3.getText(baselinesManifestKey(prefix, pipeline));
    if (!got) return null;
    return { manifest: parseManifest(got.text), etag: got.etag };
}

runsRoutes.get('/pipelines', async (c) => {
    const s3 = s3FromEnv(c.env);
    const pipelines = await Promise.all(
        PIPELINES.map(async (id) => {
            const loaded = await loadManifest(s3, c.env.BASELINES_PREFIX, id).catch(() => null);
            return {
                id,
                baselineCount: loaded?.manifest.screenshots.length ?? 0,
                baselinesUpdatedAt: loaded?.manifest.updatedAt ?? null,
            };
        })
    );
    return c.json({ pipelines });
});

async function listAllRunIds(s3: S3, pipeline: Pipeline): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
        const page = await s3.list({ prefix: runPrefix(pipeline), delimiter: '/', cursor });
        for (const p of page.prefixes) {
            const id = p.slice(runPrefix(pipeline).length).replace(/\/$/, '');
            if (/^[0-9]+$/.test(id)) ids.push(id);
        }
        cursor = page.cursor ?? undefined;
    } while (cursor);
    // Numeric descending — GitHub run ids grow monotonically, so this is newest-first.
    return ids.sort((a, b) => (a.length !== b.length ? b.length - a.length : a < b ? 1 : a > b ? -1 : 0));
}

runsRoutes.get('/pipelines/:p/runs', async (c) => {
    const p = c.req.param('p');
    if (!isPipeline(p)) return c.json({ error: `unknown pipeline "${p}"` }, 404);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 50);
    const offset = Math.max(Number(c.req.query('cursor') ?? 0) || 0, 0);

    const s3 = s3FromEnv(c.env);
    // One manifest read per page: the badge counts are LIVE (vs the current
    // baselines) — unlike meta.json's embedded CI-time report, they collapse
    // to zero once a run's changes are promoted.
    const manifest = await loadManifest(s3, c.env.BASELINES_PREFIX, p).catch(() => null);
    const shaById = baselineShaMap(manifest?.manifest.screenshots ?? []);
    const ids = await listAllRunIds(s3, p);
    const page = ids.slice(offset, offset + limit);

    const runs = (
        await Promise.all(
            page.map(async (runId) => {
                const got = await s3.getText(runMetaKey(p, runId)).catch(() => null);
                if (!got) return null; // meta.json absent → upload incomplete → hide the run
                let meta: RunMeta;
                try {
                    meta = parseRunMeta(got.text);
                } catch {
                    return null;
                }
                return {
                    runId,
                    runAttempt: meta.runAttempt,
                    repo: meta.repo,
                    workflow: meta.workflow,
                    event: meta.event,
                    branch: meta.branch,
                    prNumber: meta.prNumber,
                    commit: meta.commit,
                    commitSubject: meta.commitSubject,
                    uploadedAt: meta.uploadedAt,
                    e2e: meta.e2e,
                    screenshotCount: meta.screenshots.length,
                    live: manifest ? liveCounts(meta.screenshots, shaById) : null,
                    reportSummary: meta.report
                        ? { changed: meta.report.changed.length, added: meta.report.added.length, removed: meta.report.removed.length, driftLikely: meta.report.driftLikely }
                        : null,
                };
            })
        )
    ).filter((r) => r !== null);

    return c.json({ runs, cursor: offset + limit < ids.length ? String(offset + limit) : null });
});

export type DiffPlanStatus = 'added' | 'removed' | 'same-sha' | 'needs-diff';

runsRoutes.get('/pipelines/:p/runs/:runId', async (c) => {
    const p = c.req.param('p');
    if (!isPipeline(p)) return c.json({ error: `unknown pipeline "${p}"` }, 404);
    const runId = c.req.param('runId');
    if (!/^[0-9]{1,20}$/.test(runId)) return c.json({ error: 'bad run id' }, 400);

    const s3 = s3FromEnv(c.env);
    const got = await s3.getText(runMetaKey(p, runId));
    if (!got) return c.json({ error: 'run not found (no meta.json — expired or upload incomplete)' }, 404);
    const meta = parseRunMeta(got.text);

    const loaded = await loadManifest(s3, c.env.BASELINES_PREFIX, p);
    const baselineEntries = new Map<string, ManifestEntry>((loaded?.manifest.screenshots ?? []).map((e) => [entryId(e), e]));
    const runShots = new Map(meta.screenshots.map((s) => [entryId(s), s]));

    const diffPlan: Array<{
        name: string;
        engine: string;
        status: DiffPlanStatus;
        runSha: string | null;
        baselineSha: string | null;
        runDims: { width: number; height: number } | null;
        baselineDims: { width: number; height: number } | null;
        baselineSource: ManifestEntry['source'] | null;
    }> = [];

    for (const [id, shot] of runShots) {
        const base = baselineEntries.get(id);
        diffPlan.push({
            name: shot.name,
            engine: shot.engine,
            status: !base ? 'added' : base.sha256 === shot.sha256 ? 'same-sha' : 'needs-diff',
            runSha: shot.sha256,
            baselineSha: base?.sha256 ?? null,
            runDims: { width: shot.width, height: shot.height },
            baselineDims: base ? { width: base.width, height: base.height } : null,
            baselineSource: base?.source ?? null,
        });
    }
    for (const [id, base] of baselineEntries) {
        if (runShots.has(id)) continue;
        diffPlan.push({
            name: base.name,
            engine: base.engine,
            status: 'removed',
            runSha: null,
            baselineSha: base.sha256,
            runDims: null,
            baselineDims: { width: base.width, height: base.height },
            baselineSource: base.source ?? null,
        });
    }
    diffPlan.sort((a, b) => (a.engine !== b.engine ? (a.engine < b.engine ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return c.json({ meta, baseline: { etag: loaded?.etag ?? null, seeded: loaded !== null }, diffPlan });
});
