/**
 * One-time (re-runnable) seeding: convert a committed git manifest v2
 * (screenshot-manifest.json from pcbjam/tests or apps/tests) into the R2
 * manifest v3 that becomes the source of truth. ZERO image movement — the CAS
 * blobs already exist; every sha is HEAD-verified before the manifest is
 * written (a manifest pointing at missing objects would break CI's fetch).
 *
 * Usage:
 *   tsx scripts/seed-baselines.ts --pipeline pcbjam \
 *       --from ../pcbjam-private/pcbjam/tests/screenshot-manifest.json \
 *       [--prefix baselines-dev/] [--force] [--env-file <tests/.env>]
 *
 * Without --force the PUT is If-None-Match:* (refuses to overwrite an existing
 * manifest). Re-run with --force right before each CI cutover PR merges, to
 * sync any interim git-flow promotes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { baselinesManifestKey, casKey } from '../src/shared/keys';
import { MANIFEST_VERSION, isPipeline, serializeManifest } from '../src/shared/schemas';
import type { Manifest, ManifestEntry } from '../src/shared/schemas';
import { argValue, pool, s3FromScriptEnv } from './lib/node-s3';

type V2Entry = { name: string; engine: string; sha256: string; bytes: number; width: number; height: number };
type V2Manifest = { version: number; storage: { bucket: string; keyPrefix: string }; screenshots: V2Entry[] };

async function main(): Promise<void> {
    const argv = process.argv;
    const pipeline = argValue(argv, '--pipeline');
    const from = argValue(argv, '--from');
    const prefix = argValue(argv, '--prefix') ?? 'baselines/';
    const force = argv.includes('--force');
    if (!pipeline || !isPipeline(pipeline)) throw new Error(`--pipeline must be one of: pcbjam, closed-stack (got "${pipeline}")`);
    if (!from || !fs.existsSync(from)) throw new Error(`--from ${from ?? '<missing>'} not found`);
    if (!/^[a-z0-9-]+\/$/.test(prefix)) throw new Error(`--prefix must be a slug ending in "/" (got "${prefix}")`);

    const v2 = JSON.parse(fs.readFileSync(from, 'utf8')) as V2Manifest;
    if (v2.version !== 2) throw new Error(`${from} is manifest version ${v2.version}, expected 2`);
    if (!Array.isArray(v2.screenshots) || v2.screenshots.length === 0) throw new Error(`${from} has no screenshots`);

    // Provenance pointer back to the git state this seed came from (best effort).
    let gitRef = path.resolve(from);
    try {
        const dir = path.dirname(path.resolve(from));
        const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
        const rel = execFileSync('git', ['-C', dir, 'ls-files', '--full-name', path.basename(from)], { encoding: 'utf8' }).trim();
        gitRef = `${rel || path.basename(from)}@${sha}`;
    } catch {
        console.warn('[seed] git unavailable — recording the absolute path as provenance');
    }

    const seededAt = new Date().toISOString();
    const screenshots: ManifestEntry[] = v2.screenshots.map((e) => ({
        name: e.name,
        engine: e.engine,
        sha256: e.sha256,
        bytes: e.bytes,
        width: e.width,
        height: e.height,
        source: { kind: 'seed', seededAt, fromGitManifest: gitRef },
    }));

    const s3 = s3FromScriptEnv(argv);

    console.log(`[seed] verifying ${screenshots.length} CAS objects exist…`);
    const missing: string[] = [];
    await pool(screenshots, 16, async (e) => {
        if (!(await s3.head(casKey(e.sha256))).ok) missing.push(`${e.engine}/${e.name} (${e.sha256})`);
    });
    if (missing.length) {
        throw new Error(`refusing to seed — ${missing.length} sha(s) missing in R2:\n  ${missing.slice(0, 10).join('\n  ')}`);
    }

    const manifest: Manifest = {
        version: MANIFEST_VERSION,
        pipeline,
        storage: v2.storage,
        updatedAt: seededAt,
        updatedBy: 'seed',
        screenshots,
    };
    const key = baselinesManifestKey(prefix, pipeline);
    const put = await s3.put(key, serializeManifest(manifest), {
        contentType: 'application/json',
        ...(force ? {} : { ifNoneMatch: '*' }),
    });
    if (put.status === 412) {
        throw new Error(`${key} already exists — re-run with --force to overwrite (it will replace the current baselines!)`);
    }
    if (put.status !== 200) throw new Error(`PUT ${key} → HTTP ${put.status}`);
    console.log(`[seed] wrote ${key}: ${screenshots.length} entries from ${gitRef} (etag ${put.etag})`);
}

main().catch((e) => {
    console.error(`[seed] ${(e as Error).message}`);
    process.exitCode = 1;
});
