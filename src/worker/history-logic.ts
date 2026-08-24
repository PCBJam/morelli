/**
 * Baseline version-history derivation. No dedicated storage: commitPromotion
 * snapshots the FULL previous manifest before every manifest replace
 * (baselines/<pipeline>/history/<stamp>-<runId>.json), each entry carries its
 * own `source` provenance, and CAS blobs are immutable — so an entry's version
 * chain is reconstructed by walking snapshots newest→oldest and collecting the
 * sha changes.
 *
 * Semantics:
 *  - The chain starts at the CURRENT manifest entry (or, for a pruned entry,
 *    at the newest snapshot containing it).
 *  - Walking older snapshots, a version is appended whenever the sha differs
 *    from the last appended one (consecutive dedupe — promotes that touched
 *    OTHER entries snapshot the whole manifest but don't create a version
 *    here; a revert to an old sha IS a new version).
 *  - The chain STOPS at the first snapshot where the entry is absent: that is
 *    this baseline's lineage start (a prune + re-add starts a fresh lineage).
 */
import type { EntrySource, Manifest, ManifestEntry } from '../shared/schemas';

export type HistoryVersion = {
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    source?: EntrySource;
    /** 'current' for the live manifest entry, else the history snapshot's stamp. */
    snapshot: 'current' | string;
};

export type EntryHistory = {
    versions: HistoryVersion[];
    /** The lineage start was seen (entry absent from an older snapshot). */
    stoppedAtAbsence: boolean;
    /** Every provided snapshot was walked (false when the version cap cut the walk short). */
    consumedAll: boolean;
};

export function deriveEntryHistory(
    current: ManifestEntry | null,
    snapshotsNewestFirst: Array<{ stamp: string; manifest: Manifest }>,
    id: string,
    max = 10
): EntryHistory {
    const versions: HistoryVersion[] = [];
    let lastSha: string | null = null;

    if (current) {
        versions.push({ sha256: current.sha256, bytes: current.bytes, width: current.width, height: current.height, source: current.source as EntrySource | undefined, snapshot: 'current' });
        lastSha = current.sha256;
    }

    let stoppedAtAbsence = false;
    let consumedAll = true;
    for (const snap of snapshotsNewestFirst) {
        if (versions.length >= max) {
            consumedAll = false;
            break;
        }
        const entry = snap.manifest.screenshots.find((e) => `${e.engine}/${e.name}` === id);
        if (!entry) {
            stoppedAtAbsence = true;
            break;
        }
        if (entry.sha256 !== lastSha) {
            versions.push({ sha256: entry.sha256, bytes: entry.bytes, width: entry.width, height: entry.height, source: entry.source as EntrySource | undefined, snapshot: snap.stamp });
            lastSha = entry.sha256;
        }
    }
    return { versions, stoppedAtAbsence, consumedAll };
}
