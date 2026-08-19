/**
 * R2 key builders + the strict allowlist for the authenticated image proxy.
 *
 * Bucket layout (pcbjam-ci-screenshots):
 *   sha256/<64-hex>.png                          CAS blobs (immutable, no retention)
 *   runs/<pipeline>/<runId>/<engine>/<name>.png  per-build uploads (30-day lifecycle)
 *   runs/<pipeline>/<runId>/meta.json            upload-complete marker
 *   baselines/<pipeline>/manifest.json           manifest v3 — source of truth
 *   baselines/<pipeline>/history/<stamp>-<runId>.json
 */
import type { Pipeline } from './schemas';

export const CAS_PREFIX = 'sha256/';

export function casKey(sha256: string): string {
    return `${CAS_PREFIX}${sha256}.png`;
}

export function runPrefix(pipeline: Pipeline, runId?: string): string {
    return runId === undefined ? `runs/${pipeline}/` : `runs/${pipeline}/${runId}/`;
}

export function runImageKey(pipeline: Pipeline, runId: string, engine: string, name: string): string {
    return `runs/${pipeline}/${runId}/${engine}/${name}`;
}

export function runMetaKey(pipeline: Pipeline, runId: string): string {
    return `runs/${pipeline}/${runId}/meta.json`;
}

/** `prefix` is the Worker's BASELINES_PREFIX var ("baselines/", or "baselines-dev/" in dev). */
export function baselinesManifestKey(prefix: string, pipeline: Pipeline): string {
    return `${prefix}${pipeline}/manifest.json`;
}

/** History keys avoid `:`/`.` (ISO stamp sanitized) so keys stay in the URL-safe charset below. */
export function baselinesHistoryKey(prefix: string, pipeline: Pipeline, isoStamp: string, runId: string): string {
    return `${prefix}${pipeline}/history/${isoStamp.replace(/[:.]/g, '-')}-${runId}.json`;
}

const CAS_KEY_RE = /^sha256\/[0-9a-f]{64}\.png$/;
// engine: lowercase slug; name: no slashes, must end .png — traversal is impossible
// (no `/` inside segments, and `..` without a slash cannot climb).
const RUN_IMAGE_KEY_RE = /^runs\/(pcbjam|closed-stack)\/[0-9]{1,20}\/[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/;

/** Only PNGs the UI legitimately displays are proxyable — never manifests, meta or arbitrary keys. */
export function isAllowedProxyKey(key: string): boolean {
    return CAS_KEY_RE.test(key) || RUN_IMAGE_KEY_RE.test(key);
}
