import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, imageUrl } from '../api';
import type { BaselineHistoryResponse, HistoryVersion } from '../api';
import { casKey } from '../../shared/keys';
import { entryId } from '../../shared/schemas';
import type { ManifestEntry, Pipeline } from '../../shared/schemas';
import { computeDiff, revokeDiff } from '../diff/diff-client';
import type { DiffResult } from '../diff/diff-client';
import { ImageCompareModal } from './ImageCompareModal';
import { ProvenanceBadge } from './ProvenanceBadge';

/** Best display date for a version: its own provenance beats the snapshot stamp. */
function versionDate(v: HistoryVersion): string {
    if (v.source?.kind === 'promoted') return new Date(v.source.promotedAt).toLocaleString();
    if (v.source?.kind === 'seed') return new Date(v.source.seededAt).toLocaleString();
    return v.snapshot === 'current' ? 'current' : v.snapshot;
}

export function BaselineHistoryModal({ pipeline, entry, onClose }: { pipeline: Pipeline; entry: ManifestEntry; onClose: () => void }) {
    const id = entryId(entry);
    const history = useQuery({
        queryKey: ['baseline-history', pipeline, id],
        queryFn: () => api<BaselineHistoryResponse>(`/pipelines/${pipeline}/baselines/history?engine=${entry.engine}&name=${encodeURIComponent(entry.name)}`),
    });

    const [compare, setCompare] = useState<{ version: HistoryVersion; diff: DiffResult | null } | null>(null);
    const compareDiffRef = useRef<DiffResult | null>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !compare) onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose, compare]);

    // Release the comparison diff's object URLs on unmount.
    useEffect(
        () => () => {
            if (compareDiffRef.current) revokeDiff(compareDiffRef.current);
        },
        []
    );

    const openCompare = (version: HistoryVersion) => {
        if (compareDiffRef.current) {
            revokeDiff(compareDiffRef.current);
            compareDiffRef.current = null;
        }
        setCompare({ version, diff: null });
        computeDiff(imageUrl(casKey(version.sha256)), imageUrl(casKey(entry.sha256)), `${version.sha256}:${entry.sha256}`)
            .then((d) => {
                setCompare((c) => {
                    if (!c || c.version !== version) {
                        revokeDiff(d); // compare closed/changed while computing
                        return c;
                    }
                    compareDiffRef.current = d;
                    return { version, diff: d };
                });
            })
            .catch(() => undefined); // side-by-side still works without a diff
    };

    const closeCompare = () => {
        if (compareDiffRef.current) {
            revokeDiff(compareDiffRef.current);
            compareDiffRef.current = null;
        }
        setCompare(null);
    };

    return (
        <div className="fixed inset-0 z-40 flex flex-col bg-black/80 p-4" onClick={onClose}>
            <div
                className="mx-auto flex max-h-full w-full max-w-3xl flex-col rounded-lg border border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
                    <span className="font-mono text-sm text-zinc-800 dark:text-zinc-200">{id}</span>
                    <span className="text-xs text-zinc-500">baseline history</span>
                    <button
                        onClick={onClose}
                        className="ml-auto rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-200 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                        ✕
                    </button>
                </div>

                <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
                    {history.isPending && <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading history…</p>}
                    {history.isError && <p className="text-sm text-red-600 dark:text-red-400">Failed to load history: {(history.error as Error).message}</p>}
                    {history.data &&
                        history.data.versions.map((v, i) => (
                            <div key={`${v.snapshot}-${v.sha256}`} className="flex gap-3 rounded border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                                <div className="bg-checker w-48 shrink-0 overflow-hidden rounded">
                                    <img src={imageUrl(casKey(v.sha256))} loading="lazy" alt={`${id} version ${i}`} className="max-h-28 w-full object-contain" />
                                </div>
                                <div className="min-w-0 flex-1 space-y-1 text-xs">
                                    <div className="flex items-center gap-2">
                                        {i === 0 ? (
                                            <span className="rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
                                                current
                                            </span>
                                        ) : (
                                            <span className="rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                                                v−{i}
                                            </span>
                                        )}
                                        <span className="text-zinc-500">{versionDate(v)}</span>
                                    </div>
                                    <p className="truncate font-mono text-zinc-400 dark:text-zinc-600" title={v.sha256}>
                                        {v.sha256.slice(0, 16)}…
                                    </p>
                                    <p className="text-zinc-500">
                                        {v.width}×{v.height} · {(v.bytes / 1024).toFixed(1)} KiB
                                    </p>
                                    {v.source && <ProvenanceBadge source={v.source} />}
                                    {i > 0 && (
                                        <button
                                            onClick={() => openCompare(v)}
                                            className="mt-1 rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-200 dark:border-zinc-700 dark:hover:bg-zinc-800"
                                        >
                                            Compare with current
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    {history.data && history.data.versions.length === 1 && (
                        <p className="text-xs text-zinc-500">No older versions yet — history grows with each promote.</p>
                    )}
                    {history.data?.truncated && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                            Older history not scanned (looked at the last {history.data.scannedSnapshots} promotes).
                        </p>
                    )}
                </div>
            </div>

            {compare && (
                <ImageCompareModal
                    title={`${id} · ${versionDate(compare.version)} vs current`}
                    left={{ url: imageUrl(casKey(compare.version.sha256)), label: versionDate(compare.version) }}
                    right={{ url: imageUrl(casKey(entry.sha256)), label: 'current' }}
                    diff={compare.diff}
                    onClose={closeCompare}
                />
            )}
        </div>
    );
}
