import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { s3FromEnv } from '../s3';
import { baselinesManifestKey } from '../../shared/keys';
import { isPipeline, parseManifest } from '../../shared/schemas';

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
