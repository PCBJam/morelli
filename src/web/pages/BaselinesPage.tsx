import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, imageUrl } from '../api';
import type { BaselinesResponse } from '../api';
import { casKey } from '../../shared/keys';
import { entryId, isPipeline } from '../../shared/schemas';
import { ProvenanceBadge } from '../components/ProvenanceBadge';

export function BaselinesPage() {
    const { pipeline } = useParams();
    const p = pipeline && isPipeline(pipeline) ? pipeline : null;

    const query = useQuery({
        queryKey: ['baselines', p],
        enabled: p !== null,
        queryFn: () => api<BaselinesResponse>(`/pipelines/${p}/baselines`),
    });

    if (!p) return <p className="text-zinc-400">Unknown pipeline.</p>;
    if (query.isPending) return <p className="text-zinc-400">Loading baselines…</p>;
    if (query.isError) return <p className="text-red-400">Failed to load baselines: {(query.error as Error).message}</p>;

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
                    <div key={entryId(e)} className="rounded border border-zinc-800 bg-zinc-900/40 p-2">
                        <div className="bg-checker overflow-hidden rounded">
                            <img src={imageUrl(casKey(e.sha256))} loading="lazy" alt={entryId(e)} className="max-h-44 w-full object-contain" />
                        </div>
                        <p className="mt-2 truncate font-mono text-xs text-zinc-300" title={entryId(e)}>
                            {entryId(e)}
                        </p>
                        <p className="text-xs text-zinc-600">
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
        </div>
    );
}
