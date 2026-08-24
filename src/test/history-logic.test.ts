import { describe, expect, it } from 'vitest';
import { deriveEntryHistory } from '../worker/history-logic';
import { MANIFEST_VERSION } from '../shared/schemas';
import type { Manifest, ManifestEntry } from '../shared/schemas';

const ID = 'chromium/shot.png';

function entry(sha: string, extra: Partial<ManifestEntry> = {}): ManifestEntry {
    return { name: 'shot.png', engine: 'chromium', sha256: sha.repeat(64 / sha.length), bytes: 100, width: 10, height: 10, ...extra };
}

function snap(stamp: string, entries: ManifestEntry[]): { stamp: string; manifest: Manifest } {
    return {
        stamp,
        manifest: {
            version: MANIFEST_VERSION,
            pipeline: 'pcbjam',
            storage: { bucket: 'b', keyPrefix: 'sha256/' },
            updatedAt: stamp,
            updatedBy: 'x',
            screenshots: entries,
        },
    };
}

describe('deriveEntryHistory', () => {
    it('returns current-only when there are no snapshots', () => {
        const h = deriveEntryHistory(entry('a'), [], ID);
        expect(h.versions.map((v) => v.snapshot)).toEqual(['current']);
        expect(h.stoppedAtAbsence).toBe(false);
        expect(h.consumedAll).toBe(true);
    });

    it('dedupes consecutive identical shas (promotes that touched other entries)', () => {
        const h = deriveEntryHistory(
            entry('c'),
            [
                snap('t3', [entry('c')]), // unrelated promote — same sha
                snap('t2', [entry('b')]),
                snap('t1', [entry('b')]), // unrelated promote
                snap('t0', [entry('a')]),
            ],
            ID
        );
        expect(h.versions.map((v) => [v.sha256[0], v.snapshot])).toEqual([
            ['c', 'current'],
            ['b', 't2'],
            ['a', 't0'],
        ]);
        expect(h.consumedAll).toBe(true);
    });

    it('counts a revert to an old sha as a distinct version', () => {
        const h = deriveEntryHistory(entry('a'), [snap('t2', [entry('b')]), snap('t1', [entry('a')])], ID);
        expect(h.versions.map((v) => v.sha256[0])).toEqual(['a', 'b', 'a']);
    });

    it('stops at the first snapshot where the entry is absent (lineage start)', () => {
        const other = { ...entry('z'), name: 'other.png' };
        const h = deriveEntryHistory(entry('b'), [snap('t2', [entry('a'), other]), snap('t1', [other]), snap('t0', [entry('x'), other])], ID);
        expect(h.versions.map((v) => v.sha256[0])).toEqual(['b', 'a']); // the older 'x' lineage is not chained
        expect(h.stoppedAtAbsence).toBe(true);
    });

    it('caps at max versions and reports the walk as cut short', () => {
        const snaps = Array.from({ length: 20 }, (_, i) => snap(`t${19 - i}`, [entry(String.fromCharCode(98 + (19 - i)))]));
        const h = deriveEntryHistory(entry('a'), snaps, ID, 5);
        expect(h.versions).toHaveLength(5);
        expect(h.consumedAll).toBe(false);
        expect(h.stoppedAtAbsence).toBe(false);
    });

    it('supports a pruned entry (no current) — chain starts at the newest snapshot containing it', () => {
        const h = deriveEntryHistory(null, [snap('t1', [entry('b')]), snap('t0', [entry('a')])], ID);
        expect(h.versions.map((v) => [v.sha256[0], v.snapshot])).toEqual([
            ['b', 't1'],
            ['a', 't0'],
        ]);
    });

    it('keeps each version\'s own provenance', () => {
        const promoted = entry('b', { source: { kind: 'promoted', runId: '7', branch: 'main', commit: 'c'.repeat(40), promotedAt: 'T', promotedBy: 'u' } });
        const h = deriveEntryHistory(entry('a', { source: { kind: 'seed', seededAt: 'S', fromGitManifest: 'm' } }), [snap('t0', [promoted])], ID);
        expect(h.versions[0]?.source).toMatchObject({ kind: 'seed' });
        expect(h.versions[1]?.source).toMatchObject({ kind: 'promoted', runId: '7' });
    });
});
