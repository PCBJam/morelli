import { describe, expect, it } from 'vitest';
import { MANIFEST_VERSION, compareEntries, entryId, manifestProblems, parseManifest, serializeManifest } from '../shared/schemas';
import type { Manifest, ManifestEntry } from '../shared/schemas';

const SHA = 'a'.repeat(64);

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
    return { name: 'shot.png', engine: 'chromium', sha256: SHA, bytes: 100, width: 10, height: 10, ...over };
}

function manifest(screenshots: ManifestEntry[]): Manifest {
    return {
        version: MANIFEST_VERSION,
        pipeline: 'pcbjam',
        storage: { bucket: 'pcbjam-ci-screenshots', keyPrefix: 'sha256/' },
        updatedAt: '2026-08-19T00:00:00.000Z',
        updatedBy: 'seed',
        screenshots,
    };
}

describe('serializeManifest', () => {
    it('is 2-space JSON with trailing newline, entries sorted by (engine, name), _note first', () => {
        const m = manifest([
            entry({ engine: 'firefox', name: 'b.png' }),
            entry({ engine: 'chromium', name: 'z.png' }),
            entry({ engine: 'chromium', name: 'a.png' }),
        ]);
        const text = serializeManifest(m);
        expect(text.endsWith('}\n')).toBe(true);
        expect(text.startsWith('{\n  "_note"')).toBe(true);
        const parsed = parseManifest(text);
        expect(parsed.screenshots.map(entryId)).toEqual(['chromium/a.png', 'chromium/z.png', 'firefox/b.png']);
        expect(text).toContain('  "version": 3');
    });

    it('round-trips: serialize(parse(serialize(m))) is byte-identical', () => {
        const text = serializeManifest(manifest([entry(), entry({ name: 'other.png' })]));
        expect(serializeManifest(parseManifest(text))).toBe(text);
    });

    it('code-unit sort matches gen-manifest conventions (no locale collation)', () => {
        // 'Z' (0x5a) sorts before 'a' (0x61) in code-unit order; localeCompare would flip them.
        const a = entry({ name: 'Z.png' });
        const b = entry({ name: 'a.png' });
        expect(compareEntries(a, b)).toBeLessThan(0);
    });
});

describe('manifestProblems', () => {
    it('accepts a healthy manifest', () => {
        expect(manifestProblems(manifest([entry()]))).toEqual([]);
    });

    it('flags bad sha, dupes, non-png names and unsorted entries', () => {
        const problems = manifestProblems(
            manifest([
                entry({ engine: 'firefox', name: 'b.png' }),
                entry({ engine: 'chromium', name: 'a.txt' as string, sha256: 'nope' }),
                entry({ engine: 'chromium', name: 'a.txt' as string, sha256: 'nope' }),
            ])
        );
        expect(problems.join('\n')).toMatch(/not a \.png/);
        expect(problems.join('\n')).toMatch(/sha256/);
        expect(problems.join('\n')).toMatch(/duplicate/);
        expect(problems.join('\n')).toMatch(/not sorted/);
    });

    it('flags a wrong version and unknown pipeline', () => {
        const m = manifest([entry()]);
        (m as { version: number }).version = 2;
        (m as { pipeline: string }).pipeline = 'nope';
        const problems = manifestProblems(m);
        expect(problems.join('\n')).toMatch(/version is 2/);
        expect(problems.join('\n')).toMatch(/unknown pipeline/);
    });
});

describe('parseManifest', () => {
    it('throws on invalid JSON and on schema problems', () => {
        expect(() => parseManifest('{nope')).toThrow(/not valid JSON/);
        expect(() => parseManifest(JSON.stringify({ version: 99 }))).toThrow(/manifest invalid/);
    });
});
