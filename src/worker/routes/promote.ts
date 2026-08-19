/**
 * Two-phase promotion (see promote-logic.ts). The blob phase is chunked by the
 * client (≤25 items/call) so a mass promote never exhausts the Worker's
 * subrequest budget; the commit phase is one conditional manifest write.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { s3FromEnv } from '../s3';
import { StaleManifestError, commitPromotion, ensureBlob } from '../promote-logic';
import { isPipeline } from '../../shared/schemas';

const MAX_BLOB_ITEMS = 25;
const SHA_RE = /^[0-9a-f]{64}$/;

export const promoteRoutes = new Hono<AppEnv>();

type BlobsBody = { pipeline: string; runId: string; items: Array<{ name: string; engine: string; sha256: string }> };

promoteRoutes.post('/promote/blobs', async (c) => {
    const body = await c.req.json<BlobsBody>().catch(() => null);
    if (!body || !isPipeline(body.pipeline) || !/^[0-9]{1,20}$/.test(body.runId) || !Array.isArray(body.items)) {
        return c.json({ error: 'bad request' }, 400);
    }
    if (body.items.length === 0 || body.items.length > MAX_BLOB_ITEMS) {
        return c.json({ error: `items must be 1..${MAX_BLOB_ITEMS}` }, 400);
    }
    if (body.items.some((i) => !i.name || !i.engine || !SHA_RE.test(i.sha256 ?? ''))) {
        return c.json({ error: 'bad item' }, 400);
    }

    const s3 = s3FromEnv(c.env);
    const pipeline = body.pipeline;
    let ensured = 0;
    let existed = 0;
    const failures: Array<{ name: string; engine: string; error: string }> = [];
    const results = await Promise.allSettled(
        body.items.map((item) => ensureBlob(s3, { pipeline, runId: body.runId, ...item }))
    );
    results.forEach((r, i) => {
        const item = body.items[i]!;
        if (r.status === 'fulfilled') r.value === 'uploaded' ? ensured++ : existed++;
        else failures.push({ name: item.name, engine: item.engine, error: (r.reason as Error).message });
    });
    return c.json({ ensured, existed, failures }, failures.length ? 502 : 200);
});

type CommitBody = {
    pipeline: string;
    runId: string;
    items: Array<{ name: string; engine: string }>;
    expectedEtag: string;
    prune?: string[];
};

promoteRoutes.post('/promote/commit', async (c) => {
    const body = await c.req.json<CommitBody>().catch(() => null);
    if (
        !body ||
        !isPipeline(body.pipeline) ||
        !/^[0-9]{1,20}$/.test(body.runId) ||
        !Array.isArray(body.items) ||
        typeof body.expectedEtag !== 'string' ||
        !body.expectedEtag
    ) {
        return c.json({ error: 'bad request' }, 400);
    }
    if (body.items.length === 0 && !(body.prune?.length)) return c.json({ error: 'nothing to promote' }, 400);

    try {
        const result = await commitPromotion(s3FromEnv(c.env), {
            pipeline: body.pipeline,
            runId: body.runId,
            items: body.items,
            prune: body.prune,
            expectedEtag: body.expectedEtag,
            promotedBy: c.get('email'),
            baselinesPrefix: c.env.BASELINES_PREFIX,
        });

        if (result.wrote && c.env.DISCORD_WEBHOOK_URL) {
            const origin = new URL(c.req.url).origin;
            const lines = [
                `**morelli** baseline promote — pipeline \`${body.pipeline}\`, run \`${body.runId}\` by ${c.get('email')}`,
                `updated ${result.updated}, added ${result.added}, pruned ${result.pruned}` +
                    (result.unchangedSkipped ? `, identical-skipped ${result.unchangedSkipped}` : ''),
                `${origin}/${body.pipeline}/runs/${body.runId}`,
            ];
            c.executionCtx.waitUntil(
                fetch(c.env.DISCORD_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ content: lines.join('\n') }),
                }).catch((e) => console.warn(`[discord] post failed: ${(e as Error).message}`))
            );
        }
        return c.json(result);
    } catch (e) {
        if (e instanceof StaleManifestError) {
            return c.json({ error: 'stale', currentEtag: e.currentEtag }, 409);
        }
        throw e;
    }
});
