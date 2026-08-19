/**
 * Authenticated R2 image proxy. The bucket is private (S3 keypair on the
 * Worker), so the browser can only reach PNGs through here — and only keys the
 * UI legitimately shows (strict allowlist, never manifests/meta/arbitrary keys).
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { s3FromEnv } from '../s3';
import { CAS_PREFIX, isAllowedProxyKey } from '../../shared/keys';

export const imageRoutes = new Hono<AppEnv>();

imageRoutes.get('/image', async (c) => {
    const key = c.req.query('key') ?? '';
    if (!isAllowedProxyKey(key)) return c.json({ error: 'bad key' }, 400);

    const res = await s3FromEnv(c.env).getResponse(key);
    if (res.status === 404) return c.json({ error: 'not found' }, 404);
    if (res.status !== 200) return c.json({ error: `upstream HTTP ${res.status}` }, 502);

    return new Response(res.body, {
        headers: {
            'content-type': 'image/png',
            // CAS objects are immutable by construction; run objects expire in 30 days.
            'cache-control': key.startsWith(CAS_PREFIX) ? 'private, max-age=31536000, immutable' : 'private, max-age=3600',
        },
    });
});
