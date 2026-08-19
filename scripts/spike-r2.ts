/**
 * One-off probe: does R2's S3 API honor the conditional writes the promote
 * flow depends on? Expected transcript:
 *
 *   PUT tmp/spike-<rand>  If-None-Match:*   → 200   (create)
 *   PUT (same key)        If-None-Match:*   → 412   (already exists)
 *   PUT (same key)        If-Match:"wrong"  → 412   (etag mismatch)
 *   PUT (same key)        If-Match:<etag>   → 200   (etag match)
 *   DELETE
 *
 * Usage:  tsx scripts/spike-r2.ts [--env-file ../pcbjam-private/pcbjam/tests/.env]
 * Needs a WRITE-capable keypair. Exits non-zero if any expectation fails.
 */
import { randomBytes } from 'node:crypto';
import { s3FromScriptEnv } from './lib/node-s3';

async function main(): Promise<void> {
    const s3 = s3FromScriptEnv(process.argv);
    const key = `tmp/spike-${randomBytes(8).toString('hex')}`;
    const failures: string[] = [];
    const expect = (label: string, actual: number, wanted: number) => {
        const ok = actual === wanted;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: HTTP ${actual} (wanted ${wanted})`);
        if (!ok) failures.push(label);
    };

    const create = await s3.put(key, 'spike', { contentType: 'text/plain', ifNoneMatch: '*' });
    expect('create with If-None-Match:*', create.status, 200);

    const dupe = await s3.put(key, 'spike-2', { contentType: 'text/plain', ifNoneMatch: '*' });
    expect('duplicate create with If-None-Match:*', dupe.status, 412);

    const wrongMatch = await s3.put(key, 'spike-3', { contentType: 'text/plain', ifMatch: '"0000deadbeef0000"' });
    expect('replace with wrong If-Match', wrongMatch.status, 412);

    if (!create.etag) {
        failures.push('create returned no etag');
        console.log('FAIL create returned no etag');
    } else {
        const rightMatch = await s3.put(key, 'spike-4', { contentType: 'text/plain', ifMatch: create.etag });
        expect('replace with correct If-Match', rightMatch.status, 200);
    }

    // Cleanup — a raw signed DELETE (the S3 wrapper deliberately has no delete;
    // this probe is the one place that needs it).
    const del = await (s3 as unknown as { client: { fetch: (u: string, i: RequestInit) => Promise<Response> } }).client.fetch(
        `${(s3 as unknown as { base: string }).base}/${key}`,
        { method: 'DELETE' }
    );
    console.log(`     cleanup DELETE → HTTP ${del.status}`);

    if (failures.length) {
        console.error(`\nspike FAILED: ${failures.join('; ')} — the conditional-write design does not hold, stop and reassess`);
        process.exitCode = 1;
    } else {
        console.log('\nspike passed — conditional writes behave as the promote flow requires');
    }
}

main().catch((e) => {
    console.error(`[spike] ${(e as Error).message}`);
    process.exitCode = 1;
});
