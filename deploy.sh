#!/usr/bin/env bash
# Deploy pcbjam-morelli-staging to the STAGING Cloudflare account.
#
# Mirrors the monorepo's deploy_to_staging.sh conventions: fail-closed
# tripwires before touching anything remote, the workspace-pinned wrangler
# (never npx), and secrets uploaded atomically with the Worker from a
# gitignored env file (wrangler preserves nothing — every deploy re-sends the
# full secret set from .env.deploy).
#
# Usage:  ./deploy.sh
# Needs:  .env.deploy (cp .env.deploy.example, fill in), wrangler auth
#         (`pnpm exec wrangler login` or CLOUDFLARE_API_TOKEN in the shell).
set -Eeuo pipefail
cd "$(dirname "$0")"

STAGING_ACCOUNT_ID="5be62ba000cabfaad4d11a6ef28f8395"
WORKER_NAME="pcbjam-morelli-staging"
URL="https://pcbjam-morelli-staging.pcbjam-staging.workers.dev"

fail() { echo "deploy: $*" >&2; exit 1; }

# --- tripwires -------------------------------------------------------------
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$node_major" -ge 22 ] || fail "Node >= 22 required by wrangler (found $(node --version 2>/dev/null || echo none))"
command -v pnpm >/dev/null || fail "pnpm not found"
command -v jq >/dev/null || fail "jq not found"
grep -Fq "\"name\": \"$WORKER_NAME\"" wrangler.jsonc || fail "wrangler.jsonc does not target $WORKER_NAME"
[ -f .env.deploy ] || fail ".env.deploy missing (cp .env.deploy.example and fill it in)"

export CLOUDFLARE_ACCOUNT_ID="$STAGING_ACCOUNT_ID"
unset CLOUDFLARE_ENV
WRANGLER="pnpm exec wrangler"
$WRANGLER whoami 2>/dev/null | grep -Fq "$STAGING_ACCOUNT_ID" \
    || fail "wrangler is not authenticated against the staging account ($STAGING_ACCOUNT_ID) — run 'pnpm exec wrangler login' or set CLOUDFLARE_API_TOKEN"

# --- build -----------------------------------------------------------------
pnpm install --frozen-lockfile
pnpm run build

# --- secrets file (atomic with the deploy; never persisted world-readable) --
umask 077
SECRETS_FILE="$(mktemp)"
cleanup() { rm -f "$SECRETS_FILE"; }
trap cleanup EXIT

# shellcheck disable=SC1091
set -a; source ./.env.deploy; set +a
for required in SCREENSHOTS_S3_ENDPOINT SCREENSHOTS_S3_ACCESS_KEY_ID SCREENSHOTS_S3_SECRET_ACCESS_KEY \
                GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET SESSION_SECRET ALLOWED_EMAILS; do
    [ -n "${!required:-}" ] || fail ".env.deploy is missing $required"
done
jq -n '
  {
    SCREENSHOTS_S3_ENDPOINT: env.SCREENSHOTS_S3_ENDPOINT,
    SCREENSHOTS_S3_ACCESS_KEY_ID: env.SCREENSHOTS_S3_ACCESS_KEY_ID,
    SCREENSHOTS_S3_SECRET_ACCESS_KEY: env.SCREENSHOTS_S3_SECRET_ACCESS_KEY,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
    SESSION_SECRET: env.SESSION_SECRET,
    ALLOWED_EMAILS: env.ALLOWED_EMAILS,
    DISCORD_WEBHOOK_URL: (env.DISCORD_WEBHOOK_URL // "")
  } | with_entries(select(.value != ""))
' > "$SECRETS_FILE"

# --- deploy ----------------------------------------------------------------
$WRANGLER deploy --secrets-file "$SECRETS_FILE"

# --- smoke -----------------------------------------------------------------
echo "smoke: checking $URL"
curl -fsS -o /dev/null "$URL/" || fail "app root not reachable"
curl -fsSI "$URL/" | grep -qi 'x-robots-tag' || fail "X-Robots-Tag header missing (public/_headers not applied?)"
code="$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/auth/me")"
[ "$code" = "401" ] || fail "/api/auth/me returned $code (wanted 401 — secrets misconfigured serves 503)"
echo "deploy: OK — $URL"
