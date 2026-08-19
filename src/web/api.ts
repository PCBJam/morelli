/**
 * Typed fetch wrapper + response shapes (mirrors src/worker/routes/*).
 */
import type { EntrySource, ManifestEntry, Pipeline, RunMeta } from '../shared/schemas';

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string
    ) {
        super(message);
    }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api${path}`, init);
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
    return body as T;
}

/** The authenticated image proxy URL for an R2 key. */
export function imageUrl(key: string): string {
    return `/api/image?key=${encodeURIComponent(key)}`;
}

export type Me = { email: string };

export type PipelineInfo = { id: Pipeline; baselineCount: number; baselinesUpdatedAt: string | null };

export type RunListItem = {
    runId: string;
    runAttempt: number;
    repo: string;
    workflow: string;
    event: string;
    branch: string;
    prNumber: number | null;
    commit: string;
    commitSubject: string;
    uploadedAt: string;
    e2e: 'pass' | 'fail' | 'unknown';
    screenshotCount: number;
    reportSummary: { changed: number; added: number; removed: number; driftLikely: boolean } | null;
};

export type RunsPage = { runs: RunListItem[]; cursor: string | null };

export type DiffPlanStatus = 'added' | 'removed' | 'same-sha' | 'needs-diff';

export type DiffPlanItem = {
    name: string;
    engine: string;
    status: DiffPlanStatus;
    runSha: string | null;
    baselineSha: string | null;
    runDims: { width: number; height: number } | null;
    baselineDims: { width: number; height: number } | null;
    baselineSource: EntrySource | null;
};

export type RunDetail = { meta: RunMeta; baseline: { etag: string | null; seeded: boolean }; diffPlan: DiffPlanItem[] };

export type BaselinesResponse = {
    version: number;
    updatedAt: string;
    updatedBy: string;
    etag: string | null;
    entries: ManifestEntry[];
};

export type BlobsResult = { ensured: number; existed: number; failures: Array<{ name: string; engine: string; error: string }> };

export type CommitResult = { updated: number; added: number; pruned: number; unchangedSkipped: number; newEtag: string | null; wrote: boolean };
