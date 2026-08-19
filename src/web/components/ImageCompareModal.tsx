import { useEffect, useRef, useState } from 'react';
import { imageUrl } from '../api';
import type { DiffPlanItem } from '../api';
import { casKey, runImageKey } from '../../shared/keys';
import { entryId } from '../../shared/schemas';
import type { Pipeline } from '../../shared/schemas';
import type { DiffResult } from '../diff/diff-client';

type Tab = 'side-by-side' | 'slider' | 'diff';

export function ImageCompareModal({
    item,
    pipeline,
    runId,
    diff,
    onClose,
}: {
    item: DiffPlanItem;
    pipeline: Pipeline;
    runId: string;
    diff: DiffResult | null;
    onClose: () => void;
}) {
    const baselineUrl = item.baselineSha ? imageUrl(casKey(item.baselineSha)) : null;
    const runUrl = item.runSha ? imageUrl(runImageKey(pipeline, runId, item.engine, item.name)) : null;
    const both = baselineUrl !== null && runUrl !== null;
    const [tab, setTab] = useState<Tab>(both ? 'side-by-side' : 'side-by-side');
    const [slider, setSlider] = useState(50);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const diffCanvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        if (tab !== 'diff' || !diff?.diffBitmap || !diffCanvas.current) return;
        const canvas = diffCanvas.current;
        canvas.width = diff.width;
        canvas.height = diff.height;
        canvas.getContext('2d')?.drawImage(diff.diffBitmap, 0, 0);
    }, [tab, diff]);

    const tabBtn = (t: Tab, label: string, enabled: boolean) => (
        <button
            key={t}
            onClick={() => setTab(t)}
            disabled={!enabled}
            className={`rounded px-3 py-1 text-sm ${tab === t ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'} disabled:opacity-30`}
        >
            {label}
        </button>
    );

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-4" onClick={onClose}>
            <div className="mx-auto flex h-full w-full max-w-screen-2xl flex-col rounded-lg border border-zinc-700 bg-zinc-950" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
                    <span className="font-mono text-sm text-zinc-200">{entryId(item)}</span>
                    {diff && diff.dimsMatch && (
                        <span className="text-xs text-zinc-500">
                            {diff.diffPixels} px changed ({(diff.changedRatio * 100).toFixed(4)}%)
                        </span>
                    )}
                    {diff && !diff.dimsMatch && <span className="text-xs text-orange-400">dimensions differ</span>}
                    <div className="ml-auto flex gap-1">
                        {tabBtn('side-by-side', 'Side by side', true)}
                        {tabBtn('slider', 'Slider', both)}
                        {tabBtn('diff', 'Diff', diff?.diffBitmap != null)}
                    </div>
                    <button onClick={onClose} className="rounded border border-zinc-700 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800">
                        ✕
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-auto p-4">
                    {tab === 'side-by-side' && (
                        <div className="flex gap-3">
                            <figure className="min-w-0 flex-1">
                                <figcaption className="mb-1 text-xs text-zinc-500">baseline</figcaption>
                                {baselineUrl ? (
                                    <div className="bg-checker rounded">
                                        <img src={baselineUrl} alt="baseline" className="w-full" />
                                    </div>
                                ) : (
                                    <p className="text-sm text-zinc-600">no baseline (new screenshot)</p>
                                )}
                            </figure>
                            <figure className="min-w-0 flex-1">
                                <figcaption className="mb-1 text-xs text-zinc-500">this run</figcaption>
                                {runUrl ? (
                                    <div className="bg-checker rounded">
                                        <img src={runUrl} alt="run" className="w-full" />
                                    </div>
                                ) : (
                                    <p className="text-sm text-zinc-600">not produced by this run</p>
                                )}
                            </figure>
                        </div>
                    )}

                    {tab === 'slider' && both && (
                        <div className="space-y-2">
                            <input type="range" min={0} max={100} value={slider} onChange={(e) => setSlider(Number(e.target.value))} className="w-full" />
                            <div className="bg-checker relative overflow-hidden rounded">
                                <img src={baselineUrl} alt="baseline" className="block w-full" />
                                <div className="absolute inset-0 overflow-hidden border-r-2 border-emerald-400" style={{ width: `${slider}%` }}>
                                    <img src={runUrl} alt="run" className="block w-full max-w-none" style={{ width: '100%' }} />
                                </div>
                                <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-emerald-300">run</span>
                                <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-zinc-300">baseline</span>
                            </div>
                        </div>
                    )}

                    {tab === 'diff' && (
                        <div className="rounded bg-black">
                            <canvas ref={diffCanvas} className="w-full" />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
