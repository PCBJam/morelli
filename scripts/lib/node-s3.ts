/**
 * Node-side S3 access for the one-off scripts (spike, seed). Reuses the
 * Worker's S3 class (aws4fetch is isomorphic; Node ≥22 has global fetch).
 *
 * Credentials resolve from, in order:
 *   1. shell env  SCREENSHOTS_S3_*            (this repo's naming)
 *   2. shell env  CI_SCREENSHOTS_S3_*         (the monorepo tooling's naming — so the
 *                                              existing dev keypair in a tests/.env works)
 *   3. an env file loaded via --env-file <path> (either naming), e.g.
 *      ../pcbjam-private/pcbjam/tests/.env
 */
import * as fs from 'node:fs';
import * as process from 'node:process';
import { S3 } from '../../src/worker/s3';

const NAMES = ['SCREENSHOTS_S3_ENDPOINT', 'SCREENSHOTS_S3_BUCKET', 'SCREENSHOTS_S3_ACCESS_KEY_ID', 'SCREENSHOTS_S3_SECRET_ACCESS_KEY'] as const;

function fromEnv(prefix: 'SCREENSHOTS_S3_' | 'CI_SCREENSHOTS_S3_'): { endpoint?: string; bucket?: string; accessKeyId?: string; secretAccessKey?: string } {
    return {
        endpoint: process.env[`${prefix}ENDPOINT`],
        bucket: process.env[`${prefix}BUCKET`],
        accessKeyId: process.env[`${prefix}ACCESS_KEY_ID`],
        secretAccessKey: process.env[`${prefix}SECRET_ACCESS_KEY`],
    };
}

export function s3FromScriptEnv(argv: string[]): S3 {
    const envFileIdx = argv.indexOf('--env-file');
    if (envFileIdx !== -1) {
        const file = argv[envFileIdx + 1];
        if (!file || !fs.existsSync(file)) throw new Error(`--env-file ${file ?? '<missing>'} not found`);
        process.loadEnvFile(file);
    }
    const primary = fromEnv('SCREENSHOTS_S3_');
    const fallback = fromEnv('CI_SCREENSHOTS_S3_');
    const endpoint = primary.endpoint || fallback.endpoint;
    const accessKeyId = primary.accessKeyId || fallback.accessKeyId;
    const secretAccessKey = primary.secretAccessKey || fallback.secretAccessKey;
    const bucket = primary.bucket || fallback.bucket || 'pcbjam-ci-screenshots';
    if (!endpoint || !accessKeyId || !secretAccessKey) {
        throw new Error(
            `missing S3 credentials — set ${NAMES.join(', ')} (or the CI_SCREENSHOTS_S3_* equivalents), ` +
                'or pass --env-file <path-to-tests/.env>'
        );
    }
    return new S3({ endpoint, bucket, accessKeyId, secretAccessKey });
}

export function argValue(argv: string[], flag: string): string | undefined {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
}

/** Bounded-concurrency map, same shape as the CI tooling's r2-sync pool. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]!);
        }
    });
    await Promise.all(workers);
    return results;
}
