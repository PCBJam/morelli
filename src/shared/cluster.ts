/**
 * "Where to look" boxes — connected-component clustering over the changed-pixel
 * mask. PORTED VERBATIM (minus pngjs) from the CI tooling's image-ops.ts
 * (pcbjam/tests/tools/screenshots/image-ops.ts: dilate/cluster/mask readback),
 * so morelli's boxes match the Discord triptych pixel-for-pixel. Keep in
 * lockstep with that file; knobs live in compare-config.ts CLUSTER.
 */
import { CLUSTER } from './compare-config';

export type Box = { x: number; y: number; width: number; height: number; area: number };

/**
 * Changed-pixel mask read back from pixelmatch's output image: pixels painted
 * with the red diff colour. AA pixels are yellow, so they stay excluded.
 */
export function maskFromDiffOutput(out: Uint8ClampedArray, width: number, height: number): Uint8Array {
    const mask = new Uint8Array(width * height);
    for (let p = 0; p < width * height; p++) {
        const o = p * 4;
        if (out[o]! > 200 && out[o + 1]! < 80 && out[o + 2]! < 80) mask[p] = 1;
    }
    return mask;
}

/** Dilate a boolean mask by `r` (square structuring element), out of place. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
    if (r <= 0) return mask;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!mask[y * w + x]) continue;
            const y0 = Math.max(0, y - r);
            const y1 = Math.min(h - 1, y + r);
            const x0 = Math.max(0, x - r);
            const x1 = Math.min(w - 1, x + r);
            for (let yy = y0; yy <= y1; yy++) {
                for (let xx = x0; xx <= x1; xx++) out[yy * w + xx] = 1;
            }
        }
    }
    return out;
}

/**
 * Draw 2px rectangle outlines for each box INSIDE its bounds, mutating `data`
 * in place — a verbatim pixel port of the CI tooling's drawBoxes (image-ops.ts)
 * so morelli's boxes render pixel-identical to the Discord triptych.
 */
export function drawBoxesOnImageData(data: Uint8ClampedArray, width: number, height: number, boxes: Box[]): void {
    const [r, g, b] = CLUSTER.boxColor;
    const set = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const o = (y * width + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
    };
    for (const box of boxes) {
        for (let t = 0; t < 2; t++) {
            for (let x = box.x; x < box.x + box.width; x++) {
                set(x, box.y + t);
                set(x, box.y + box.height - 1 - t);
            }
            for (let y = box.y; y < box.y + box.height; y++) {
                set(box.x + t, y);
                set(box.x + box.width - 1 - t, y);
            }
        }
    }
}

/**
 * 8-connected connected-components over the (dilated) mask → bounding boxes,
 * largest-area first, capped at CLUSTER.maxBoxes, specks below
 * CLUSTER.minBoxArea dropped.
 */
export function cluster(mask: Uint8Array, w: number, h: number): Box[] {
    const grown = dilate(mask, w, h, CLUSTER.dilate);
    const seen = new Uint8Array(w * h);
    const boxes: Box[] = [];
    const stack: number[] = [];

    for (let start = 0; start < grown.length; start++) {
        if (!grown[start] || seen[start]) continue;
        let minX = w,
            minY = h,
            maxX = 0,
            maxY = 0;
        stack.push(start);
        seen[start] = 1;
        while (stack.length) {
            const p = stack.pop()!;
            const px = p % w;
            const py = (p - px) / w;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const nx = px + dx;
                    const ny = py + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    const np = ny * w + nx;
                    if (grown[np] && !seen[np]) {
                        seen[np] = 1;
                        stack.push(np);
                    }
                }
            }
        }
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const area = bw * bh;
        if (area >= CLUSTER.minBoxArea) boxes.push({ x: minX, y: minY, width: bw, height: bh, area });
    }
    boxes.sort((p, q) => q.area - p.area);
    return boxes.slice(0, CLUSTER.maxBoxes);
}
