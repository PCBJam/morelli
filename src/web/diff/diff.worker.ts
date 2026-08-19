/**
 * Pixel-diff web worker. Mirrors CI's compare.ts semantics: pixelmatch with the
 * shared settings; a dimension mismatch is treated as fully changed (CI pads
 * with magenta and calls it changed — here the card just shows ratio 1).
 * No pngjs — the browser decodes PNGs (createImageBitmap → OffscreenCanvas).
 */
import pixelmatch from 'pixelmatch';
import { DIFF_COLOR, PIXELMATCH } from '../../shared/compare-config';
import { cluster, maskFromDiffOutput } from '../../shared/cluster';
import type { Box } from '../../shared/cluster';

export type DiffRequest = { id: number; baselineUrl: string; runUrl: string };
export type DiffSuccess = {
    id: number;
    ok: true;
    dimsMatch: boolean;
    changedRatio: number;
    diffPixels: number;
    width: number;
    height: number;
    /** pixelmatch's output image — what the CI triptych calls the heatmap. */
    diffBitmap: ImageBitmap | null;
    /** "Where to look" cluster boxes, largest-first (same algorithm as CI's red boxes). */
    boxes: Box[];
};
export type DiffFailure = { id: number; ok: false; error: string };
export type DiffResponse = DiffSuccess | DiffFailure;

const scope = self as unknown as {
    postMessage(msg: DiffResponse, transfer?: Transferable[]): void;
    addEventListener(type: 'message', fn: (ev: MessageEvent<DiffRequest>) => void): void;
};

async function loadImageData(url: string): Promise<ImageData> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

async function diff(req: DiffRequest): Promise<DiffSuccess> {
    const [a, b] = await Promise.all([loadImageData(req.baselineUrl), loadImageData(req.runUrl)]);
    if (a.width !== b.width || a.height !== b.height) {
        return {
            id: req.id,
            ok: true,
            dimsMatch: false,
            changedRatio: 1,
            diffPixels: b.width * b.height,
            width: b.width,
            height: b.height,
            diffBitmap: null,
            boxes: [],
        };
    }
    const { width, height } = a;
    const out = new Uint8ClampedArray(width * height * 4);
    const diffPixels = pixelmatch(a.data, b.data, out, width, height, { ...PIXELMATCH, diffColor: DIFF_COLOR });
    const boxes = diffPixels > 0 ? cluster(maskFromDiffOutput(out, width, height), width, height) : [];
    const diffBitmap = await createImageBitmap(new ImageData(out, width, height));
    return { id: req.id, ok: true, dimsMatch: true, changedRatio: diffPixels / (width * height), diffPixels, width, height, diffBitmap, boxes };
}

scope.addEventListener('message', (ev) => {
    void diff(ev.data)
        .then((res) => scope.postMessage(res, res.diffBitmap ? [res.diffBitmap] : []))
        .catch((e: unknown) => scope.postMessage({ id: ev.data.id, ok: false, error: (e as Error).message }));
});
