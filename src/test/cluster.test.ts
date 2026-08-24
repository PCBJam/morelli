import { describe, expect, it } from 'vitest';
import { cluster, drawBoxesOnImageData, maskFromDiffOutput } from '../shared/cluster';
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

describe('drawBoxesOnImageData', () => {
    const [R, G, B] = CLUSTER.boxColor;
    const px = (data: Uint8ClampedArray, w: number, x: number, y: number) => [...data.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

    it('draws a 2px outline INSIDE the box bounds, leaving the interior and exterior untouched', () => {
        const w = 12;
        const h = 12;
        const data = new Uint8ClampedArray(w * h * 4); // all zeros
        drawBoxesOnImageData(data, w, h, [{ x: 2, y: 2, width: 8, height: 8, area: 64 }]);
        expect(px(data, w, 2, 2)).toEqual([R, G, B, 255]); // outer ring
        expect(px(data, w, 3, 3)).toEqual([R, G, B, 255]); // inner ring (2px thickness)
        expect(px(data, w, 9, 9)).toEqual([R, G, B, 255]); // opposite corner, inside bounds
        expect(px(data, w, 4, 4)).toEqual([0, 0, 0, 0]); // interior untouched
        expect(px(data, w, 1, 1)).toEqual([0, 0, 0, 0]); // exterior untouched
        expect(px(data, w, 10, 10)).toEqual([0, 0, 0, 0]); // just outside the box
    });

    it('clamps boxes that touch the image border', () => {
        const w = 4;
        const h = 4;
        const data = new Uint8ClampedArray(w * h * 4);
        expect(() => drawBoxesOnImageData(data, w, h, [{ x: 0, y: 0, width: 6, height: 6, area: 36 }])).not.toThrow();
        expect(px(data, w, 0, 0)).toEqual([R, G, B, 255]); // top/left edges in-bounds
        expect(px(data, w, 3, 1)).toEqual([R, G, B, 255]); // top ring spans the clamped width
        // The box's bottom/right edges (rows/cols 4-5) fall OUTSIDE the image and
        // clamp away entirely — the far corner stays untouched (CI-identical).
        expect(px(data, w, 3, 3)).toEqual([0, 0, 0, 0]);
    });

    it('fully paints boxes smaller than the 4px double-outline', () => {
        const w = 8;
        const h = 8;
        const data = new Uint8ClampedArray(w * h * 4);
        drawBoxesOnImageData(data, w, h, [{ x: 2, y: 2, width: 3, height: 3, area: 9 }]);
        for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) expect(px(data, w, x, y)).toEqual([R, G, B, 255]);
        expect(px(data, w, 5, 5)).toEqual([0, 0, 0, 0]);
    });
});
