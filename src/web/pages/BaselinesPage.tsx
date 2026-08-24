import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, imageUrl } from '../api';
import type { BaselinesResponse } from '../api';
import { casKey } from '../../shared/keys';
import { entryId, isPipeline } from '../../shared/schemas';
import type { ManifestEntry } from '../../shared/schemas';
import { ProvenanceBadge } from '../components/ProvenanceBadge';
import { BaselineHistoryModal } from '../components/BaselineHistoryModal';

export function BaselinesPage() {
    const { pipeline } = useParams();
    const p = pipeline && isPipeline(pipeline) ? pipeline : null;
    const [historyFor, setHistoryFor] = useState<ManifestEntry | null>(null);

    const query = useQuery({
        queryKey: ['baselines', p],
        enabled: p !== null,
        queryFn: () => api<BaselinesResponse>(`/pipelines/${p}/baselines`),
    });

    if (!p) return <p className="text-zinc-500 dark:text-zinc-400">Unknown pipeline.</p>;
    if (query.isPending) return <p className="text-zinc-500 dark:text-zinc-400">Loading baselines…</p>;
    if (query.isError) return <p className="text-red-600 dark:text-red-400">Failed to load baselines: {(query.error as Error).message}</p>;

    const { entries, updatedAt, updatedBy } = query.data;

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-3">
                <h1 className="text-lg font-semibold">Baselines · {p}</h1>
                <span className="text-sm text-zinc-500">
                    {entries.length} screenshots · updated {new Date(updatedAt).toLocaleString()} by {updatedBy}
                </span>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {entries.map((e) => (
                    <div key={entryId(e)} className="rounded border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                        <div className="bg-checker overflow-hidden rounded">
                            <img src={imageUrl(casKey(e.sha256))} loading="lazy" alt={entryId(e)} className="max-h-44 w-full object-contain" />
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                            <p className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300" title={entryId(e)}>
                                {entryId(e)}
                            </p>
                            <button
                                onClick={() => setHistoryFor(e)}
                                className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-200 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                                title="Browse this baseline's version history"
                            >
                                History
                            </button>
                        </div>
                        <p className="text-xs text-zinc-500 dark:text-zinc-600">
                            {e.width}×{e.height} · {(e.bytes / 1024).toFixed(1)} KiB
                        </p>
                        {e.source && (
                            <div className="mt-1">
                                <ProvenanceBadge source={e.source} />
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {historyFor && <BaselineHistoryModal pipeline={p} entry={historyFor} onClose={() => setHistoryFor(null)} />}
        </div>
    );
}
