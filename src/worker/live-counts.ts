/**
 * Live drift of a run against the CURRENT baselines, by sha comparison. This
 * is what the runs list shows — unlike the CI-time report embedded in
 * meta.json, it drops to zero once the run's changes are promoted.
 */
import type { ManifestEntry, RunScreenshot } from '../shared/schemas';

export type LiveCounts = { changed: number; added: number; removed: number };

export function liveCounts(shots: RunScreenshot[], baselineShaById: Map<string, string>): LiveCounts {
    let changed = 0;
    let added = 0;
    const seen = new Set<string>();
    for (const s of shots) {
        const id = `${s.engine}/${s.name}`;
        seen.add(id);
        const baseSha = baselineShaById.get(id);
        if (baseSha === undefined) added++;
        else if (baseSha !== s.sha256) changed++;
    }
    let removed = 0;
    for (const id of baselineShaById.keys()) if (!seen.has(id)) removed++;
    return { changed, added, removed };
}

export function baselineShaMap(entries: ManifestEntry[]): Map<string, string> {
    return new Map(entries.map((e) => [`${e.engine}/${e.name}`, e.sha256]));
}
