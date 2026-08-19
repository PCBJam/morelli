/**
 * GitHub OAuth (authorization-code flow, scope user:email). GitHub only
 * AUTHENTICATES; authorization is the ALLOWED_EMAILS allowlist — any signed-in
 * GitHub user with no allowlisted verified email is bounced to /login?error=forbidden.
 */
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { publicOrigin } from '../env';
import {
    SESSION_COOKIE,
    clearSessionCookie,
    createSessionValue,
    isAllowedEmail,
    randomHex,
    readAndClearStateCookie,
    setSessionCookie,
    setStateCookie,
    verifySessionValue,
} from '../auth';

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_EMAILS = 'https://api.github.com/user/emails';

export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/login', (c) => {
    const state = randomHex(16);
    setStateCookie(c, state);
    const origin = publicOrigin(c.env, c.req.url);
    const params = new URLSearchParams({
        client_id: c.env.GITHUB_CLIENT_ID,
        redirect_uri: `${origin}/api/auth/callback/github`,
        scope: 'user:email',
        state,
    });
    return c.redirect(`${GITHUB_AUTHORIZE}?${params}`);
});

authRoutes.get('/callback/github', async (c) => {
    const origin = publicOrigin(c.env, c.req.url);
    const fail = (reason: string) => c.redirect(`${origin}/login?error=${reason}`);

    const state = c.req.query('state');
    const code = c.req.query('code');
    const expected = readAndClearStateCookie(c);
    if (!code || !state || !expected || state !== expected) return fail('state');

    const tokenRes = await fetch(GITHUB_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
            client_id: c.env.GITHUB_CLIENT_ID,
            client_secret: c.env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: `${origin}/api/auth/callback/github`,
        }),
    });
    const token = tokenRes.ok ? ((await tokenRes.json()) as { access_token?: string }).access_token : undefined;
    if (!token) return fail('oauth');

    const emailsRes = await fetch(GITHUB_EMAILS, {
        headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'pcbjam-morelli', // GitHub's API rejects requests without one
        },
    });
    if (!emailsRes.ok) return fail('oauth');
    const emails = (await emailsRes.json()) as Array<{ email: string; verified: boolean; primary: boolean }>;

    const allowed = emails.find((e) => e.verified && isAllowedEmail(c, e.email));
    if (!allowed) {
        console.warn('[auth] sign-in refused: no allowlisted verified email'); // deliberately not logging the emails
        return fail('forbidden');
    }

    setSessionCookie(c, await createSessionValue(c.env.SESSION_SECRET, allowed.email.toLowerCase(), Date.now()));
    return c.redirect(`${origin}/`);
});

authRoutes.post('/logout', (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
    const email = await verifySessionValue(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE), Date.now());
    if (!email) return c.json({ error: 'unauthenticated' }, 401);
    return c.json({ email });
});
