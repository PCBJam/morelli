/**
 * Live drift of a run against the CURRENT baselines. This is what the runs
 * list shows — unlike the CI-time report embedded in meta.json, it collapses
 * once the run's changes are promoted.
 *
 * IMPORTANT: the pcbjam renderer is not byte-reproducible — fonts/AA jitter
 * change most PNGs' bytes on every run without changing them visually, so a
 * bare sha comparison counts ~everything as changed forever. When the run
 * carries its CI-time pixel classification (meta.report), `changed` therefore
 * counts only entries that were MEANINGFULLY changed at CI time (above the CI
 * pixel floor) and still don't match the current baselines. Without a report
 * we fall back to the (overstating) sha comparison.
 */
import type { ManifestEntry, RunMeta, RunScreenshot } from '../shared/schemas';

export type LiveCounts = { changed: number; added: number; removed: number };

export function liveCounts(shots: RunScreenshot[], baselineShaById: Map<string, string>, ciChangedIds: Set<string> | null): LiveCounts {
    let changed = 0;
    let added = 0;
    const seen = new Set<string>();
    for (const s of shots) {
        const id = `${s.engine}/${s.name}`;
        seen.add(id);
        const baseSha = baselineShaById.get(id);
        if (baseSha === undefined) added++;
        else if (baseSha !== s.sha256 && (ciChangedIds === null || ciChangedIds.has(id))) changed++;
    }
    let removed = 0;
    for (const id of baselineShaById.keys()) if (!seen.has(id)) removed++;
    return { changed, added, removed };
}

export function baselineShaMap(entries: ManifestEntry[]): Map<string, string> {
    return new Map(entries.map((e) => [`${e.engine}/${e.name}`, e.sha256]));
}

/** Ids the CI-time compare classified as meaningfully changed; null when the run has no report. */
export function ciChangedIdSet(meta: RunMeta): Set<string> | null {
    if (!meta.report) return null;
    return new Set(meta.report.changed.map((c) => `${c.engine}/${c.name}`));
}
