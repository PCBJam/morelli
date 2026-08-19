import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, imageUrl } from '../api';
import type { BlobsResult, CommitResult, DiffPlanItem, RunDetail } from '../api';
import { casKey, runImageKey } from '../../shared/keys';
import { entryId, isPipeline } from '../../shared/schemas';
import type { Pipeline } from '../../shared/schemas';
import { floorFor } from '../../shared/compare-config';
import { computeDiff } from '../diff/diff-client';
import type { DiffResult } from '../diff/diff-client';
import { ImageCompareModal } from '../components/ImageCompareModal';
import { ProvenanceBadge } from '../components/ProvenanceBadge';

type DiffState = Record<string, DiffResult | 'error' | undefined>;

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function StatusChip({ item, diff }: { item: DiffPlanItem; diff: DiffResult | 'error' | undefined }) {
    if (item.status === 'added') return <span className="rounded border border-emerald-900 bg-emerald-950 px-1.5 py-0.5 text-xs text-emerald-300">added</span>;
    if (item.status === 'removed') return <span className="rounded border border-red-900 bg-red-950 px-1.5 py-0.5 text-xs text-red-300">missing in run</span>;
    if (item.status === 'same-sha') return <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-400">identical</span>;
    if (diff === undefined) return <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-500">diffing…</span>;
    if (diff === 'error') return <span className="rounded border border-red-900 bg-red-950 px-1.5 py-0.5 text-xs text-red-300">diff failed</span>;
    const floor = floorFor(item.engine).changedRatio;
    const pct = (diff.changedRatio * 100).toFixed(diff.changedRatio > 0 && diff.changedRatio < 0.001 ? 4 : 2);
    if (!diff.dimsMatch) return <span className="rounded border border-orange-900 bg-orange-950 px-1.5 py-0.5 text-xs text-orange-300">size changed</span>;
    return diff.changedRatio > floor ? (
        <span className="rounded border border-orange-900 bg-orange-950 px-1.5 py-0.5 text-xs text-orange-300">changed {pct}%</span>
    ) : (
        <span className="rounded border border-yellow-900 bg-yellow-950 px-1.5 py-0.5 text-xs text-yellow-300">≈ unchanged {pct}%</span>
    );
}

export function RunComparePage() {
    const params = useParams();
    const p: Pipeline | null = params.pipeline && isPipeline(params.pipeline) ? params.pipeline : null;
    const runId = params.runId ?? '';
    const qc = useQueryClient();

    const detail = useQuery({
        queryKey: ['run', p, runId],
        enabled: p !== null && runId !== '',
        queryFn: () => api<RunDetail>(`/pipelines/${p}/runs/${runId}`),
    });

    const [diffs, setDiffs] = useState<DiffState>({});
    const requested = useRef(new Set<string>());
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [pruneSel, setPruneSel] = useState<Set<string>>(new Set());
    const [modalItem, setModalItem] = useState<DiffPlanItem | null>(null);
    const [promoting, setPromoting] = useState(false);
    const [progress, setProgress] = useState<string | null>(null);
    const [result, setResult] = useState<CommitResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Kick off pixel diffs for every needs-diff item exactly once per page load.
    useEffect(() => {
        if (!detail.data || !p) return;
        for (const item of detail.data.diffPlan) {
            const id = entryId(item);
            if (item.status !== 'needs-diff' || requested.current.has(id) || !item.baselineSha) continue;
            requested.current.add(id);
            computeDiff(imageUrl(casKey(item.baselineSha)), imageUrl(runImageKey(p, runId, item.engine, item.name)))
                .then((r) => setDiffs((d) => ({ ...d, [id]: r })))
                .catch(() => setDiffs((d) => ({ ...d, [id]: 'error' })));
        }
    }, [detail.data, p, runId]);

    const plan = detail.data?.diffPlan ?? [];
    const promotable = useMemo(() => plan.filter((i) => i.status === 'added' || i.status === 'needs-diff'), [plan]);
    const interesting = useMemo(() => plan.filter((i) => i.status !== 'same-sha'), [plan]);
    const identicalCount = plan.length - interesting.length;

    if (!p) return <p className="text-zinc-400">Unknown pipeline.</p>;
    if (detail.isPending) return <p className="text-zinc-400">Loading run…</p>;
    if (detail.isError) return <p className="text-red-400">Failed to load run: {(detail.error as Error).message}</p>;

    const { meta, baseline } = detail.data;

    const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        apply(next);
    };

    const doPromote = async () => {
        if (!baseline.etag) {
            setError('No baseline manifest yet — run the seed script first.');
            return;
        }
        setPromoting(true);
        setError(null);
        setResult(null);
        try {
            const items = promotable
                .filter((i) => selected.has(entryId(i)) && i.runSha)
                .map((i) => ({ name: i.name, engine: i.engine, sha256: i.runSha! }));
            const batches = chunk(items, 25);
            for (let b = 0; b < batches.length; b++) {
                setProgress(`Uploading baseline bytes… batch ${b + 1}/${batches.length}`);
                const res = await api<BlobsResult>('/promote/blobs', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ pipeline: p, runId, items: batches[b] }),
                });
                if (res.failures.length) throw new Error(`blob upload failed: ${res.failures[0]!.error}`);
            }
            setProgress('Committing manifest…');
            const commit = await api<CommitResult>('/promote/commit', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    pipeline: p,
                    runId,
                    items: items.map(({ name, engine }) => ({ name, engine })),
                    prune: [...pruneSel],
                    expectedEtag: baseline.etag,
                }),
            });
            setResult(commit);
            setSelected(new Set());
            setPruneSel(new Set());
            requested.current.clear();
            setDiffs({});
            await Promise.all([
                qc.invalidateQueries({ queryKey: ['run', p, runId] }),
                qc.invalidateQueries({ queryKey: ['baselines', p] }),
                qc.invalidateQueries({ queryKey: ['pipelines'] }),
            ]);
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
                setError('Baselines changed while you were reviewing (someone else promoted). Reload the page and re-select.');
            } else {
                setError((e as Error).message);
            }
        } finally {
            setPromoting(false);
            setProgress(null);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Link to={`/${p}/runs`} className="text-sm text-zinc-500 hover:text-zinc-300">
                    ← runs
                </Link>
                <h1 className="text-lg font-semibold">
                    Run <span className="font-mono">#{runId}</span>
                </h1>
                <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs text-zinc-400">{meta.branch}</span>
                <span className="truncate text-sm text-zinc-400">{meta.commitSubject || meta.commit.slice(0, 10)}</span>
                <a
                    className="text-xs text-zinc-500 underline hover:text-zinc-300"
                    href={`https://github.com/${meta.repo}/actions/runs/${runId}`}
                    target="_blank"
                    rel="noreferrer"
                >
                    GitHub run ↗
                </a>
            </div>

            {!baseline.seeded && (
                <p className="rounded border border-amber-900 bg-amber-950/50 p-3 text-sm text-amber-300">
                    No baseline manifest for this pipeline yet — everything shows as “added”. Seed baselines first.
                </p>
            )}

            <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-900/50 p-3 text-sm">
                <span className="text-zinc-400">
                    {plan.length} screenshots · {identicalCount} identical · {interesting.length} to review
                </span>
                <div className="ml-auto flex items-center gap-2">
                    <button
                        onClick={() => setSelected(new Set(promotable.map(entryId)))}
                        className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                    >
                        Select all changed + added ({promotable.length})
                    </button>
                    <button onClick={() => { setSelected(new Set()); setPruneSel(new Set()); }} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">
                        Clear
                    </button>
                    <button
                        onClick={() => void doPromote()}
                        disabled={promoting || (selected.size === 0 && pruneSel.size === 0)}
                        className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
                    >
                        {promoting ? (progress ?? 'Promoting…') : `Promote ${selected.size}${pruneSel.size ? ` + prune ${pruneSel.size}` : ''}`}
                    </button>
                </div>
            </div>

            {error && <p className="rounded border border-red-900 bg-red-950/50 p-3 text-sm text-red-300">{error}</p>}
            {result && (
                <p className="rounded border border-emerald-900 bg-emerald-950/50 p-3 text-sm text-emerald-300">
                    Promoted: {result.updated} updated, {result.added} added, {result.pruned} pruned
                    {result.unchangedSkipped ? `, ${result.unchangedSkipped} identical skipped` : ''}.
                </p>
            )}

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {interesting.map((item) => {
                    const id = entryId(item);
                    const diff = diffs[id];
                    const selectable = item.status === 'added' || item.status === 'needs-diff';
                    return (
                        <div key={id} className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
                            <div className="mb-2 flex items-center gap-2">
                                {selectable ? (
                                    <input
                                        type="checkbox"
                                        checked={selected.has(id)}
                                        onChange={() => toggle(selected, id, setSelected)}
                                        className="h-4 w-4 accent-emerald-600"
                                        title="Select for promotion"
                                    />
                                ) : (
                                    <input
                                        type="checkbox"
                                        checked={pruneSel.has(id)}
                                        onChange={() => toggle(pruneSel, id, setPruneSel)}
                                        className="h-4 w-4 accent-red-600"
                                        title="Prune this baseline (screenshot no longer produced)"
                                    />
                                )}
                                <button onClick={() => setModalItem(item)} className="min-w-0 flex-1 truncate text-left font-mono text-xs text-zinc-300 hover:text-white" title={id}>
                                    {id}
                                </button>
                                <StatusChip item={item} diff={diff} />
                            </div>
                            <button onClick={() => setModalItem(item)} className="block w-full">
                                <div className="flex gap-1">
                                    {item.baselineSha && (
                                        <div className="bg-checker min-w-0 flex-1 overflow-hidden rounded">
                                            <img src={imageUrl(casKey(item.baselineSha))} loading="lazy" alt={`${id} baseline`} className="max-h-40 w-full object-contain" />
                                        </div>
                                    )}
                                    {item.runSha && (
                                        <div className="bg-checker min-w-0 flex-1 overflow-hidden rounded">
                                            <img src={imageUrl(runImageKey(p, runId, item.engine, item.name))} loading="lazy" alt={`${id} run`} className="max-h-40 w-full object-contain" />
                                        </div>
                                    )}
                                </div>
                            </button>
                            {item.baselineSource && (
                                <div className="mt-2">
                                    <ProvenanceBadge source={item.baselineSource} />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {interesting.length === 0 && <p className="rounded border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">Every screenshot is byte-identical to its baseline. Nothing to review.</p>}

            {modalItem && (
                <ImageCompareModal
                    item={modalItem}
                    pipeline={p}
                    runId={runId}
                    diff={typeof diffs[entryId(modalItem)] === 'object' ? (diffs[entryId(modalItem)] as DiffResult) : null}
                    onClose={() => setModalItem(null)}
                />
            )}
        </div>
    );
}
