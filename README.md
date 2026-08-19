# morelli

PCBJam **screenshot review & promotion**: browse each CI run's screenshots,
compare them against the baselines, and promote selected screenshots (single or
bulk) to become the new baselines — entirely from the UI. R2 is the source of
truth; nothing touches git.

Staging: <https://pcbjam-morelli-staging.pcbjam-staging.workers.dev>

## Architecture

One Cloudflare Worker (`pcbjam-morelli-staging`, **staging** CF account):
a Hono API under `/api/*` plus the React/Vite SPA served as Workers Assets.
No database — GitHub OAuth proves an email, `ALLOWED_EMAILS` authorizes it,
and the session is a stateless HMAC-signed cookie.

The screenshot bucket `pcbjam-ci-screenshots` lives on the **prod** CF account,
so there is **no native R2 binding** — all access is over the S3 API
(aws4fetch) with a keypair from secrets. Do not "simplify" this to a binding;
it cannot work cross-account.

### Bucket layout

```
sha256/<64-hex>.png                          CAS blobs — immutable baseline bytes, no retention
runs/<pipeline>/<runId>/<engine>/<name>.png  per-CI-run uploads — 30-day lifecycle rule
runs/<pipeline>/<runId>/meta.json            written LAST by CI = upload-complete marker
baselines/<pipeline>/manifest.json           manifest v3 — THE source of truth (CI fetches this)
baselines/<pipeline>/history/<stamp>-<runId>.json   pre-promote snapshots (revert path)
```

`pipeline` ∈ `pcbjam` (KiCad WASM e2e, repo PCBJam/pcbjam) and `closed-stack`
(apps/tests e2e, repo PCBJam/pcbjam-private). Canonical schemas live in
`src/shared/schemas.ts`; the CI uploader tools in both repos carry mirrored
copies (deliberate-copy convention).

### Promotion

Two-phase, chunked to respect the Worker subrequest budget:

1. `POST /api/promote/blobs` (≤25 items/call) — copy each run screenshot's
   verbatim bytes into the CAS, re-hashing with `crypto.subtle` first so a bad
   uploader sha can never poison the content-addressed store.
2. `POST /api/promote/commit` — one conditional manifest write (`If-Match` on
   the etag the client loaded; concurrent promotes get a 409), preceded by a
   history snapshot. Identical shas are skipped churn-free.

## Development

```sh
pnpm install
cp .dev.vars.example .dev.vars    # fill in (dev OAuth app, S3 keypair, BASELINES_PREFIX=baselines-dev/)
pnpm dev:worker                   # wrangler dev on :8787 (talks to the real bucket)
pnpm dev                          # vite on :5173, /api proxied to :8787 — open this one
pnpm test                         # vitest
pnpm typecheck
```

`.dev.vars` sets `BASELINES_PREFIX=baselines-dev/`, so local promotes can never
touch the real baselines. Seed the dev prefix (and the real one, once) with:

```sh
pnpm seed -- --pipeline pcbjam --from ../pcbjam-private/pcbjam/tests/screenshot-manifest.json \
    --prefix baselines-dev/ --env-file ../pcbjam-private/pcbjam/tests/.env
```

`scripts/spike-r2.ts` probes the conditional-write semantics the promote flow
depends on (`pnpm spike -- --env-file …`) — run it once against the real bucket
after any R2 API change of note.

## Deploy

```sh
cp .env.deploy.example .env.deploy   # fill in
pnpm exec wrangler login             # or CLOUDFLARE_API_TOKEN in the shell
./deploy.sh
```

`deploy.sh` is pinned to the staging account id and refuses anything else;
secrets ship atomically with the Worker from `.env.deploy` (the Worker's secret
set is exactly that file — removing a line removes the secret).

## One-time infra (already provisioned / for reference)

- R2 lifecycle rule on the prod account:
  `wrangler r2 bucket lifecycle add pcbjam-ci-screenshots expire-run-uploads runs/ --expire-days 30`
- GitHub OAuth apps: staging callback
  `https://pcbjam-morelli-staging.pcbjam-staging.workers.dev/api/auth/callback/github`,
  dev callback `http://localhost:5173/api/auth/callback/github`.
- CI write keypair (`CI_SCREENSHOTS_S3_WRITE_*` secrets in both repos) for the
  upload-run steps; this app's own keypair needs read+write+list.
