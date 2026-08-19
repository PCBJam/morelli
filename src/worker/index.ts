/**
 * morelli — PCBJam screenshot review & promotion.
 *
 * Single Worker: static SPA from ./dist (Workers Assets; only /api/* reaches
 * this code, per wrangler.jsonc run_worker_first), Hono API below.
 *
 * Route order matters: /auth is registered BEFORE the session middleware so
 * login/callback stay reachable; everything after requires a valid session.
 */
import { Hono } from 'hono';
import type { AppEnv } from './env';
import { missingEnv } from './env';
import { requireSession } from './auth';
import { authRoutes } from './routes/auth';
import { runsRoutes } from './routes/runs';
import { baselinesRoutes } from './routes/baselines';
import { imageRoutes } from './routes/image';
import { promoteRoutes } from './routes/promote';

const app = new Hono<AppEnv>().basePath('/api');

// Fail closed: a misdeployed Worker (missing secrets, empty allowlist) serves
// 503 for everything rather than degrading open.
app.use('*', async (c, next) => {
    const missing = missingEnv(c.env);
    if (missing.length) {
        console.error(`[env] missing bindings: ${missing.join(', ')}`);
        return c.json({ error: 'misconfigured' }, 503);
    }
    await next();
});

app.route('/auth', authRoutes);

app.use('*', requireSession);
app.route('/', runsRoutes);
app.route('/', baselinesRoutes);
app.route('/', imageRoutes);
app.route('/', promoteRoutes);

app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((err, c) => {
    console.error(`[api] ${c.req.method} ${new URL(c.req.url).pathname}: ${err.message}`);
    return c.json({ error: err.message }, 500);
});

export default app;
