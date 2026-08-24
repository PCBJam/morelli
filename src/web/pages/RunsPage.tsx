import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { RunListItem, RunsPage as RunsPageData } from '../api';
import { isPipeline } from '../../shared/schemas';

function E2eBadge({ e2e }: { e2e: RunListItem['e2e'] }) {
    const style =
        e2e === 'pass'
            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
            : e2e === 'fail'
              ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
              : 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400';
    return <span className={`rounded border px-1.5 py-0.5 text-xs font-medium ${style}`}>{e2e}</span>;
}

export function RunsPage() {
    const { pipeline } = useParams();
    const p = pipeline && isPipeline(pipeline) ? pipeline : null;

    const query = useInfiniteQuery({
        queryKey: ['runs', p],
        enabled: p !== null,
        queryFn: ({ pageParam }) => api<RunsPageData>(`/pipelines/${p}/runs?limit=20${pageParam ? `&cursor=${pageParam}` : ''}`),
        initialPageParam: '',
        getNextPageParam: (last) => last.cursor,
    });

    if (!p) return <p className="text-zinc-500 dark:text-zinc-400">Unknown pipeline.</p>;
    if (query.isPending) return <p className="text-zinc-500 dark:text-zinc-400">Loading runs…</p>;
    if (query.isError) return <p className="text-red-600 dark:text-red-400">Failed to load runs: {(query.error as Error).message}</p>;

    const runs = query.data.pages.flatMap((page) => page.runs);

    return (
        <div className="space-y-3">
            <h1 className="text-lg font-semibold">CI runs · {p}</h1>
            {runs.length === 0 && (
                <p className="rounded border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
                    No uploaded runs yet — runs appear here once CI's screenshot upload step has run (30-day retention).
                </p>
            )}
            <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {runs.map((run) => (
                    <li key={run.runId}>
                        <Link
                            to={`/${p}/runs/${run.runId}`}
                            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                        >
                            <span className="font-mono text-sm text-zinc-700 dark:text-zinc-300">#{run.runId}</span>
                            <E2eBadge e2e={run.e2e} />
                            <span className="rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                                {run.branch}
                            </span>
                            {run.prNumber !== null && <span className="text-xs text-zinc-500">PR #{run.prNumber}</span>}
                            <span className="min-w-0 flex-1 truncate text-sm text-zinc-700 dark:text-zinc-300">
                                {run.commitSubject || run.commit.slice(0, 10)}
                            </span>
                            {run.reportSummary && run.reportSummary.changed + run.reportSummary.added + run.reportSummary.removed > 0 && (
                                <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                                    Δ {run.reportSummary.changed} changed · {run.reportSummary.added} added · {run.reportSummary.removed} removed
                                    {run.reportSummary.driftLikely ? ' · drift?' : ''}
                                </span>
                            )}
                            <span className="text-xs text-zinc-500">{run.screenshotCount} shots</span>
                            <span className="text-xs text-zinc-500">{new Date(run.uploadedAt).toLocaleString()}</span>
                        </Link>
                    </li>
                ))}
            </ul>
            {query.hasNextPage && (
                <button
                    onClick={() => void query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                    className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-200 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                    {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
            )}
        </div>
    );
}
