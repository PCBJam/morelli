import { useEffect, useState } from 'react';
import type { DiffResult } from '../diff/diff-client';

export type CompareSide = { url: string; label: string };

type Tab = 'side-by-side' | 'slider' | 'boxes' | 'heatmap';

/**
 * Full-screen comparison of two images with CI-parity diff views. Generic over
 * its sides: the run page passes baseline/run, the baseline-history modal
 * passes an old version/current.
 */
export function ImageCompareModal({
    title,
    left,
    right,
    diff,
    onClose,
}: {
    title: string;
    left: CompareSide | null;
    right: CompareSide | null;
    diff: DiffResult | null;
    onClose: () => void;
}) {
    const both = left !== null && right !== null;
    const [tab, setTab] = useState<Tab>('side-by-side');
    const [slider, setSlider] = useState(50);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const tabBtn = (t: Tab, label: string, enabled: boolean) => (
        <button
            key={t}
            onClick={() => setTab(t)}
            disabled={!enabled}
            className={`rounded px-3 py-1 text-sm ${
                tab === t
                    ? 'bg-zinc-300 text-zinc-900 dark:bg-zinc-700 dark:text-white'
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
            } disabled:opacity-30`}
        >
            {label}
        </button>
    );

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-4" onClick={onClose}>
            <div
                className="mx-auto flex h-full w-full max-w-screen-2xl flex-col rounded-lg border border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
                    <span className="font-mono text-sm text-zinc-800 dark:text-zinc-200">{title}</span>
                    {diff && diff.dimsMatch && (
                        <span className="text-xs text-zinc-500">
                            {diff.diffPixels} px changed ({(diff.changedRatio * 100).toFixed(4)}%)
                        </span>
                    )}
                    {diff && !diff.dimsMatch && <span className="text-xs text-orange-500 dark:text-orange-400">dimensions differ</span>}
                    <div className="ml-auto flex gap-1">
                        {tabBtn('side-by-side', 'Side by side', true)}
                        {tabBtn('slider', 'Slider', both)}
                        {tabBtn('boxes', diff && diff.boxes.length > 0 ? `Boxes (${diff.boxes.length})` : 'Boxes', diff?.boxesUrl != null)}
                        {tabBtn('heatmap', 'Heatmap', diff?.heatmapUrl != null)}
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-200 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                        ✕
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-auto p-4">
                    {tab === 'side-by-side' && (
                        <div className="flex gap-3">
                            <figure className="min-w-0 flex-1">
                                <figcaption className="mb-1 text-xs text-zinc-500">{left?.label ?? '—'}</figcaption>
                                {left ? (
                                    <div className="bg-checker rounded">
                                        <img src={left.url} alt={left.label} className="w-full" />
                                    </div>
                                ) : (
                                    <p className="text-sm text-zinc-500 dark:text-zinc-600">no image</p>
                                )}
                            </figure>
                            <figure className="min-w-0 flex-1">
                                <figcaption className="mb-1 text-xs text-zinc-500">{right?.label ?? '—'}</figcaption>
                                {right ? (
                                    <div className="bg-checker rounded">
                                        <img src={right.url} alt={right.label} className="w-full" />
                                    </div>
                                ) : (
                                    <p className="text-sm text-zinc-500 dark:text-zinc-600">no image</p>
                                )}
                            </figure>
                        </div>
                    )}

                    {tab === 'slider' && both && (
                        <div className="space-y-2">
                            <input type="range" min={0} max={100} value={slider} onChange={(e) => setSlider(Number(e.target.value))} className="w-full" />
                            <div className="bg-checker relative overflow-hidden rounded">
                                <img src={left.url} alt={left.label} className="block w-full" />
                                {/* Full-size overlay clipped from the right — keeps both images
                                    pixel-aligned; the slider only reveals, never resizes. */}
                                <img
                                    src={right.url}
                                    alt={right.label}
                                    className="absolute left-0 top-0 block w-full"
                                    style={{ clipPath: `inset(0 ${100 - slider}% 0 0)` }}
                                />
                                <div className="absolute bottom-0 top-0 w-0.5 bg-emerald-400" style={{ left: `${slider}%` }} />
                                <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-emerald-300">{right.label}</span>
                                <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-zinc-300">{left.label}</span>
                            </div>
                        </div>
                    )}

                    {tab === 'boxes' && diff?.boxesUrl && (
                        <div className="bg-checker rounded">
                            <img src={diff.boxesUrl} alt="run with change boxes" className="w-full" />
                        </div>
                    )}

                    {tab === 'heatmap' && diff?.heatmapUrl && (
                        <div className="bg-checker rounded">
                            <img src={diff.heatmapUrl} alt="pixel diff heatmap" className="w-full" />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
