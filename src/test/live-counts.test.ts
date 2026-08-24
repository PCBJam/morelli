import { describe, expect, it } from 'vitest';
import { baselineShaMap, ciChangedIdSet, liveCounts } from '../worker/live-counts';
import type { ManifestEntry, RunMeta, RunScreenshot } from '../shared/schemas';

function shot(name: string, sha: string): RunScreenshot {
    return { name, engine: 'chromium', sha256: sha.repeat(64), bytes: 1, width: 1, height: 1 };
}
function entry(name: string, sha: string): ManifestEntry {
    return { name, engine: 'chromium', sha256: sha.repeat(64), bytes: 1, width: 1, height: 1 };
}

describe('liveCounts', () => {
    const baselines = baselineShaMap([entry('a.png', 'a'), entry('b.png', 'b'), entry('gone.png', 'g')]);
    // a: byte-noise diff (below the CI floor), b: meaningful diff, new: added.
    const shots = [shot('a.png', 'x'), shot('b.png', 'y'), shot('new.png', 'n')];

    it('with a CI report, counts only meaningfully-changed entries that still differ', () => {
        const ciChanged = new Set(['chromium/b.png']);
        expect(liveCounts(shots, baselines, ciChanged)).toEqual({ changed: 1, added: 1, removed: 1 });
    });

    it('collapses after promoting the meaningful change (byte-noise never counts)', () => {
        const promoted = baselineShaMap([entry('a.png', 'a'), entry('b.png', 'y'), entry('gone.png', 'g'), entry('new.png', 'n')]);
        expect(liveCounts(shots, promoted, new Set(['chromium/b.png']))).toEqual({ changed: 0, added: 0, removed: 1 });
    });

    it('falls back to sha comparison without a CI report', () => {
        expect(liveCounts(shots, baselines, null)).toEqual({ changed: 2, added: 1, removed: 1 });
    });
});

describe('ciChangedIdSet', () => {
    it('extracts engine-qualified ids from the report, null without one', () => {
        const meta = { report: { changed: [{ name: 'a.png', engine: 'chromium', changedRatio: 0.1, driftHint: null }], added: [], removed: [], unchangedCount: 0, driftLikely: false } } as unknown as RunMeta;
        expect([...ciChangedIdSet(meta)!]).toEqual(['chromium/a.png']);
        expect(ciChangedIdSet({} as RunMeta)).toBeNull();
    });
});
