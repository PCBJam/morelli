import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, imageUrl } from '../api';
import type { BlobsResult, CommitResult, DiffPlanItem, RunDetail } from '../api';
import { casKey, runImageKey } from '../../shared/keys';
import { entryId, isPipeline } from '../../shared/schemas';
import type { Pipeline } from '../../shared/schemas';
import { NEGLIGIBLE_RATIO, floorFor } from '../../shared/compare-config';
import { computeDiff, revokeDiff } from '../diff/diff-client';
import type { DiffResult } from '../diff/diff-client';
import { ImageCompareModal } from '../components/ImageCompareModal';
import { ProvenanceBadge } from '../components/ProvenanceBadge';

type DiffState = Record<string, DiffResult | 'error' | undefined>;
type ViewMode = 'heatmap' | 'boxes';
type SortMode = 'most-changed' | 'least-changed' | 'name-asc' | 'name-desc';

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function cmpId(a: DiffPlanItem, b: DiffPlanItem): number {
    const ia = entryId(a);
    const ib = entryId(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Sub-noise-floor diff (≤0.01%): treated as fine — green chip, excluded from the default bulk selection. */
function isNegligible(item: DiffPlanItem, diff: DiffResult | 'error' | undefined): boolean {
    return item.status === 'needs-diff' && typeof diff === 'object' && diff !== undefined && diff.dimsMatch && diff.changedRatio <= NEGLIGIBLE_RATIO;
}

/** Change metric for sorting: added/removed count as full change; null = not yet known. */
function changeMetric(item: DiffPlanItem, diff: DiffResult | 'error' | undefined): number | null {
    if (item.status === 'added' || item.status === 'removed') return 1;
    if (typeof diff !== 'object' || diff === undefined) return null; // pending or error
    return diff.dimsMatch ? diff.changedRatio : 1;
}

const chipClass = {
    green: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
    red: 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
    orange: 'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-300',
    yellow: 'border-yellow-300 bg-yellow-50 text-yellow-700 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-300',
    zinc: 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
    muted: 'border-zinc-300 bg-zinc-100 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500',
} as const;

/** Pulsing placeholder card shown while the run data / diffs aren't ready. */
function SkeletonCard() {
    return (
        <div className="animate-pulse rounded border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="mb-2 flex items-center gap-2">
                <div className="h-4 w-4 rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-3 flex-1 rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-4 w-20 rounded bg-zinc-200 dark:bg-zinc-800" />
            </div>
            <div className="flex gap-1">
                <div className="h-32 flex-1 rounded bg-zinc-100 dark:bg-zinc-800/60" />
                <div className="h-32 flex-1 rounded bg-zinc-100 dark:bg-zinc-800/60" />
            </div>
            <div className="mt-2 h-2.5 w-2/3 rounded bg-zinc-100 dark:bg-zinc-800/60" />
        </div>
    );
}

function SkeletonGrid({ count }: { count: number }) {
    return (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: count }, (_, i) => (
                <SkeletonCard key={i} />
            ))}
        </div>
    );
}

function StatusChip({ item, diff }: { item: DiffPlanItem; diff: DiffResult | 'error' | undefined }) {
    const chip = (cls: string, text: string) => <span className={`rounded border px-1.5 py-0.5 text-xs ${cls}`}>{text}</span>;
    if (item.status === 'added') return chip(chipClass.green, 'added');
    if (item.status === 'removed') return chip(chipClass.red, 'missing in run');
    if (item.status === 'same-sha') return chip(chipClass.zinc, 'identical');
    if (diff === undefined) return chip(chipClass.muted, 'diffing…');
    if (diff === 'error') return chip(chipClass.red, 'diff failed');
    const floor = floorFor(item.engine).changedRatio;
    const pct = (diff.changedRatio * 100).toFixed(diff.changedRatio > 0 && diff.changedRatio < 0.001 ? 4 : 2);
    if (!diff.dimsMatch) return chip(chipClass.orange, 'size changed');
    if (diff.changedRatio <= NEGLIGIBLE_RATIO) return chip(chipClass.green, `≈ identical ${pct}%`);
    return diff.changedRatio > floor ? chip(chipClass.orange, `changed ${pct}%`) : chip(chipClass.yellow, `≈ unchanged ${pct}%`);
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
    // Mirror of `diffs` so unmount cleanup and late arrivers can revoke object
    // URLs without stale-closure hazards.
    const diffsRef = useRef<DiffState>({});
    const requested = useRef(new Set<string>());
    const [viewMode, setViewMode] = useState<ViewMode>('heatmap');
    const [sortMode, setSortMode] = useState<SortMode>('most-changed');
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [pruneSel, setPruneSel] = useState<Set<string>>(new Set());
    const [modalItem, setModalItem] = useState<DiffPlanItem | null>(null);
    const [promoting, setPromoting] = useState(false);
    const [progress, setProgress] = useState<string | null>(null);
    const [result, setResult] = useState<CommitResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const putDiff = (id: string, value: DiffResult | 'error') => {
        setDiffs((d) => {
            const prev = d[id];
            if (typeof prev === 'object' && prev !== undefined) revokeDiff(prev); // replace → release old URLs
            const next = { ...d, [id]: value };
            diffsRef.current = next;
            return next;
        });
    };

    const revokeAll = () => {
        for (const v of Object.values(diffsRef.current)) {
            if (typeof v === 'object' && v !== undefined) revokeDiff(v);
        }
        diffsRef.current = {};
    };

    // Release every object URL when leaving the page.
    useEffect(() => revokeAll, []);

    // Kick off pixel diffs for every needs-diff item exactly once per page load.
    useEffect(() => {
        if (!detail.data || !p) return;
        for (const item of detail.data.diffPlan) {
            const id = entryId(item);
            if (item.status !== 'needs-diff' || requested.current.has(id) || !item.baselineSha) continue;
            requested.current.add(id);
            // Content-addressed cache key: any promote/re-run changes a sha → miss.
            computeDiff(imageUrl(casKey(item.baselineSha)), imageUrl(runImageKey(p, runId, item.engine, item.name)), `${item.baselineSha}:${item.runSha}`)
                .then((r) => putDiff(id, r))
                .catch(() => putDiff(id, 'error'));
        }
    }, [detail.data, p, runId]);

    const plan = detail.data?.diffPlan ?? [];
    const promotable = useMemo(() => plan.filter((i) => i.status === 'added' || i.status === 'needs-diff'), [plan]);
    const interesting = useMemo(() => plan.filter((i) => i.status !== 'same-sha'), [plan]);
    const identicalCount = plan.length - interesting.length;
    // Sub-0.01% diffs are "fine" — the default bulk selection skips them.
    const worthPromoting = useMemo(() => promotable.filter((i) => !isNegligible(i, diffs[entryId(i)])), [promotable, diffs]);
    const negligibleCount = promotable.length - worthPromoting.length;
    const diffable = useMemo(() => interesting.filter((i) => i.status === 'needs-diff' && i.baselineSha), [interesting]);
    const pendingDiffs = diffable.filter((i) => diffs[entryId(i)] === undefined).length;

    // Sort. The changed modes apply only once every diff is known — reordering
    // while results stream in made the grid jump around; until then the cards
    // stay in the server's stable (engine, name) order behind a progress bar.
    // On a cache-warm revisit pendingDiffs collapses immediately, so the sort
    // is effectively instant.
    const sorted = useMemo(() => {
        const items = [...interesting];
        if (sortMode === 'name-asc') return items.sort(cmpId);
        if (sortMode === 'name-desc') return items.sort((a, b) => -cmpId(a, b));
        if (pendingDiffs > 0) return items; // stable server order while computing
        const known = items.filter((i) => changeMetric(i, diffs[entryId(i)]) !== null);
        const rest = items.filter((i) => changeMetric(i, diffs[entryId(i)]) === null); // diff errors
        const dir = sortMode === 'most-changed' ? -1 : 1;
        known.sort((a, b) => {
            const ma = changeMetric(a, diffs[entryId(a)])!;
            const mb = changeMetric(b, diffs[entryId(b)])!;
            return ma !== mb ? dir * (ma - mb) : cmpId(a, b);
        });
        return [...known, ...rest];
    }, [interesting, diffs, sortMode, pendingDiffs]);

    if (!p) return <p className="text-zinc-500 dark:text-zinc-400">Unknown pipeline.</p>;
    if (detail.isPending)
        return (
            <div className="space-y-4">
                <div className="h-6 w-72 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-12 animate-pulse rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/50" />
                <SkeletonGrid count={9} />
            </div>
        );
    if (detail.isError) return <p className="text-red-600 dark:text-red-400">Failed to load run: {(detail.error as Error).message}</p>;

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
            revokeAll();
            setDiffs({});
            await Promise.all([
                qc.invalidateQueries({ queryKey: ['run', p, runId] }),
                qc.invalidateQueries({ queryKey: ['runs', p] }), // live badges collapse after a promote
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

    const segBtn = (mode: ViewMode, label: string) => (
        <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`px-2.5 py-1 text-xs font-medium ${
                viewMode === mode
                    ? 'bg-zinc-300 text-zinc-900 dark:bg-zinc-700 dark:text-white'
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
            }`}
        >
            {label}
        </button>
    );

    /** The card's right panel: the selected diff rendering, falling back to the raw run capture. */
    const rightPanelSrc = (item: DiffPlanItem, diff: DiffResult | 'error' | undefined): string | null => {
        if (!item.runSha) return null;
        const runSrc = imageUrl(runImageKey(p, runId, item.engine, item.name));
        if (item.status !== 'needs-diff' || typeof diff !== 'object' || diff === undefined || !diff.dimsMatch) return runSrc;
        return (viewMode === 'boxes' ? diff.boxesUrl : diff.heatmapUrl) ?? runSrc;
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Link to={`/${p}/runs`} className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300">
                    ← runs
                </Link>
                <h1 className="text-lg font-semibold">
                    Run <span className="font-mono">#{runId}</span>
                </h1>
                <span className="rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{meta.branch}</span>
                <span className="truncate text-sm text-zinc-600 dark:text-zinc-400">{meta.commitSubject || meta.commit.slice(0, 10)}</span>
                <a
                    className="text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-300"
                    href={`https://github.com/${meta.repo}/actions/runs/${runId}`}
                    target="_blank"
                    rel="noreferrer"
                >
                    GitHub run ↗
                </a>
            </div>

            {!baseline.seeded && (
                <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
                    No baseline manifest for this pipeline yet — everything shows as “added”. Seed baselines first.
                </p>
            )}

            <div className="flex flex-wrap items-center gap-3 rounded border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/50">
                <span className="text-zinc-500 dark:text-zinc-400">
                    {plan.length} screenshots · {identicalCount} identical · {interesting.length} to review
                    {negligibleCount > 0 && (
                        <span className="text-emerald-600 dark:text-emerald-400"> · {negligibleCount} ≈ identical (≤0.01%)</span>
                    )}
                </span>
                {pendingDiffs > 0 && (
                    <span className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400" title="Sorting applies when comparison finishes">
                        <span className="h-1.5 w-24 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
                            <span
                                className="block h-full bg-emerald-500 transition-[width] duration-300"
                                style={{ width: `${Math.round(((diffable.length - pendingDiffs) / Math.max(diffable.length, 1)) * 100)}%` }}
                            />
                        </span>
                        comparing {diffable.length - pendingDiffs}/{diffable.length}…
                    </span>
                )}
                <div className="flex overflow-hidden rounded border border-zinc-300 dark:border-zinc-700" title="Right image of each card">
                    {segBtn('heatmap', 'Heatmap')}
                    {segBtn('boxes', 'Boxes')}
                </div>
                <select
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                    className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    title="Sort order"
                >
                    <option value="most-changed">Most changed first</option>
                    <option value="least-changed">Least changed first</option>
                    <option value="name-asc">Name A→Z</option>
                    <option value="name-desc">Name Z→A</option>
                </select>
                <div className="ml-auto flex items-center gap-2">
                    <button
                        onClick={() => setSelected(new Set(worthPromoting.map(entryId)))}
                        title={negligibleCount > 0 ? `${negligibleCount} ≈ identical (≤0.01%) screenshots are skipped` : undefined}
                        className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-200 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                        Select all changed + added ({worthPromoting.length})
                    </button>
                    <button
                        onClick={() => {
                            setSelected(new Set());
                            setPruneSel(new Set());
                        }}
                        className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-200 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
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

            {error && (
                <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">{error}</p>
            )}
            {result && (
                <p className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300">
                    Promoted: {result.updated} updated, {result.added} added, {result.pruned} pruned
                    {result.unchangedSkipped ? `, ${result.unchangedSkipped} identical skipped` : ''}.
                </p>
            )}

            {pendingDiffs > 0 ? (
                <SkeletonGrid count={Math.min(interesting.length, 12)} />
            ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {sorted.map((item) => {
                    const id = entryId(item);
                    const diff = diffs[id];
                    const selectable = item.status === 'added' || item.status === 'needs-diff';
                    const rightSrc = rightPanelSrc(item, diff);
                    return (
                        <div key={id} className="rounded border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
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
                                <button
                                    onClick={() => setModalItem(item)}
                                    className="min-w-0 flex-1 truncate text-left font-mono text-xs text-zinc-700 hover:text-black dark:text-zinc-300 dark:hover:text-white"
                                    title={id}
                                >
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
                                    {rightSrc && (
                                        <div className="bg-checker min-w-0 flex-1 overflow-hidden rounded">
                                            <img src={rightSrc} loading="lazy" alt={`${id} ${viewMode}`} className="max-h-40 w-full object-contain" />
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
            )}

            {interesting.length === 0 && (
                <p className="rounded border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
                    Every screenshot is byte-identical to its baseline. Nothing to review.
                </p>
            )}

            {modalItem && (
                <ImageCompareModal
                    title={entryId(modalItem)}
                    left={modalItem.baselineSha ? { url: imageUrl(casKey(modalItem.baselineSha)), label: 'baseline' } : null}
                    right={modalItem.runSha ? { url: imageUrl(runImageKey(p, runId, modalItem.engine, modalItem.name)), label: 'this run' } : null}
                    diff={typeof diffs[entryId(modalItem)] === 'object' ? (diffs[entryId(modalItem)] as DiffResult) : null}
                    onClose={() => setModalItem(null)}
                />
            )}
        </div>
    );
}
