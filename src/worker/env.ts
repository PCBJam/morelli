/**
 * Worker bindings. Everything except the two wrangler `vars` is a secret,
 * uploaded atomically with the Worker by deploy.sh (--secrets-file) or provided
 * by .dev.vars locally.
 */
export type Env = {
    // S3 access to the screenshot bucket. The bucket lives on the PROD CF
    // account while this Worker runs on STAGING, so there is no native R2
    // binding — aws4fetch over the S3 API is the only path.
    SCREENSHOTS_S3_ENDPOINT: string;
    SCREENSHOTS_S3_BUCKET: string;
    SCREENSHOTS_S3_ACCESS_KEY_ID: string;
    SCREENSHOTS_S3_SECRET_ACCESS_KEY: string;
    /** "baselines/" in staging; "baselines-dev/" in .dev.vars so dev promotes are inert. */
    BASELINES_PREFIX: string;

    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    SESSION_SECRET: string;
    /** Comma-separated allowlist of GitHub-verified emails. Empty ⇒ the Worker serves 503 (fail closed). */
    ALLOWED_EMAILS: string;

    DISCORD_WEBHOOK_URL?: string;
    /** Dev only: the vite origin (http://localhost:5173) the OAuth flow runs behind. */
    PUBLIC_ORIGIN?: string;

    ASSETS?: Fetcher;
};

export type AppEnv = { Bindings: Env; Variables: { email: string } };

const REQUIRED: Array<keyof Env> = [
    'SCREENSHOTS_S3_ENDPOINT',
    'SCREENSHOTS_S3_BUCKET',
    'SCREENSHOTS_S3_ACCESS_KEY_ID',
    'SCREENSHOTS_S3_SECRET_ACCESS_KEY',
    'BASELINES_PREFIX',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'SESSION_SECRET',
    'ALLOWED_EMAILS',
];

/** Names of required bindings that are unset/empty — non-empty means serve 503, never degrade open. */
export function missingEnv(env: Env): string[] {
    return REQUIRED.filter((k) => !env[k]);
}

export function allowedEmails(env: Env): string[] {
    return env.ALLOWED_EMAILS.split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
}

/** The origin the browser is on (OAuth redirects, links) — PUBLIC_ORIGIN wins in dev where vite proxies /api. */
export function publicOrigin(env: Env, requestUrl: string): string {
    return env.PUBLIC_ORIGIN || new URL(requestUrl).origin;
}
