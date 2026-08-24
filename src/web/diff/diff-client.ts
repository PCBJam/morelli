/**
 * Main-thread facade over the diff worker: one shared worker, a small
 * concurrency gate (image decode is the expensive part), promise-per-request.
 *
 * The worker posts PNG Blobs; object URLs are created HERE (and revoked via
 * revokeDiff) so the whole URL lifecycle lives in the main realm.
 */
import type { Box } from '../../shared/cluster';
import type { DiffRequest, DiffResponse } from './diff.worker';

export type DiffResult = {
    dimsMatch: boolean;
    changedRatio: number;
    diffPixels: number;
    width: number;
    height: number;
    boxes: Box[];
    /** Object URL of pixelmatch's output PNG (the CI heatmap); null on dims mismatch. */
    heatmapUrl: string | null;
    /** Object URL of the run render with red cluster boxes baked in; null when no boxes. */
    boxesUrl: string | null;
};

/** Release a result's object URLs. Safe to call more than once. */
export function revokeDiff(d: DiffResult): void {
    if (d.heatmapUrl) URL.revokeObjectURL(d.heatmapUrl);
    if (d.boxesUrl) URL.revokeObjectURL(d.boxesUrl);
}

const CONCURRENCY = 3;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: DiffResult) => void; reject: (e: Error) => void }>();
let inFlight = 0;
const queue: Array<() => void> = [];

function ensureWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (ev: MessageEvent<DiffResponse>) => {
        const entry = pending.get(ev.data.id);
        if (!entry) return;
        pending.delete(ev.data.id);
        inFlight--;
        queue.shift()?.();
        if (ev.data.ok) {
            const { dimsMatch, changedRatio, diffPixels, width, height, boxes, heatmapBlob, boxesBlob } = ev.data;
            entry.resolve({
                dimsMatch,
                changedRatio,
                diffPixels,
                width,
                height,
                boxes,
                heatmapUrl: heatmapBlob ? URL.createObjectURL(heatmapBlob) : null,
                boxesUrl: boxesBlob ? URL.createObjectURL(boxesBlob) : null,
            });
        } else {
            entry.reject(new Error(ev.data.error));
        }
    });
    return worker;
}

export function computeDiff(baselineUrl: string, runUrl: string): Promise<DiffResult> {
    return new Promise((resolve, reject) => {
        const start = () => {
            inFlight++;
            const id = nextId++;
            pending.set(id, { resolve, reject });
            const req: DiffRequest = { id, baselineUrl, runUrl };
            ensureWorker().postMessage(req);
        };
        if (inFlight < CONCURRENCY) start();
        else queue.push(start);
    });
}
