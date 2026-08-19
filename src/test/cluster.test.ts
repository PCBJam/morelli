import { describe, expect, it } from 'vitest';
import { cluster, maskFromDiffOutput } from '../shared/cluster';
import { CLUSTER } from '../shared/compare-config';

function maskOf(w: number, h: number, pixels: Array<[number, number]>): Uint8Array {
    const mask = new Uint8Array(w * h);
    for (const [x, y] of pixels) mask[y * w + x] = 1;
    return mask;
}

describe('maskFromDiffOutput', () => {
    it('keys on red diff pixels and excludes yellow AA pixels', () => {
        const out = new Uint8ClampedArray(3 * 1 * 4);
        out.set([255, 0, 0, 255], 0); // red diff pixel
        out.set([255, 255, 0, 255], 4); // yellow AA pixel — excluded
        out.set([120, 120, 120, 255], 8); // dimmed background
        expect([...maskFromDiffOutput(out, 3, 1)]).toEqual([1, 0, 0]);
    });
});

describe('cluster', () => {
    it('merges nearby pixels into one dilated box (CI semantics)', () => {
        // (2,2) and (5,5): dilate=2 squares overlap → one 8-connected component
        // spanning x/y 0..7 → a single 8×8 box.
        const boxes = cluster(maskOf(20, 20, [[2, 2], [5, 5]]), 20, 20);
        expect(boxes).toEqual([{ x: 0, y: 0, width: 8, height: 8, area: 64 }]);
    });

    it('keeps separate blobs separate and sorts largest-first', () => {
        const boxes = cluster(maskOf(40, 40, [[2, 2], [30, 30], [31, 30], [30, 31]]), 40, 40);
        expect(boxes).toHaveLength(2);
        expect(boxes[0]!.area).toBeGreaterThan(boxes[1]!.area);
        expect(boxes[0]).toMatchObject({ x: 28, y: 28, width: 6, height: 6 });
        expect(boxes[1]).toMatchObject({ x: 0, y: 0, width: 5, height: 5, area: 25 });
    });

    it('caps at CLUSTER.maxBoxes largest boxes', () => {
        // 8 far-apart specks (dilated to 5×5 each) → capped at maxBoxes.
        const pixels: Array<[number, number]> = Array.from({ length: 8 }, (_, i) => [10 + i * 12, 10] as [number, number]);
        const boxes = cluster(maskOf(120, 20, pixels), 120, 20);
        expect(boxes).toHaveLength(CLUSTER.maxBoxes);
    });

    it('returns nothing for an empty mask', () => {
        expect(cluster(new Uint8Array(100), 10, 10)).toEqual([]);
    });
});
