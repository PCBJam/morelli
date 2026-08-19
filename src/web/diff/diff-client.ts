/**
 * Main-thread facade over the diff worker: one shared worker, a small
 * concurrency gate (image decode is the expensive part), promise-per-request.
 */
import type { DiffRequest, DiffResponse, DiffSuccess } from './diff.worker';

export type DiffResult = Omit<DiffSuccess, 'id' | 'ok'>;

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
            const { id: _id, ok: _ok, ...rest } = ev.data;
            entry.resolve(rest);
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
