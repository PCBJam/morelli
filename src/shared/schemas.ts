/**
 * CANONICAL schema definitions for the screenshot R2 bucket's JSON documents.
 *
 * Two other codebases carry mirrored copies of these shapes (deliberate-copy
 * convention, no shared package): the CI uploader tools
 *   pcbjam/tests/tools/screenshots/upload-run.ts        (PCBJam/pcbjam)
 *   apps/tests/tools/screenshots/upload-run.ts          (PCBJam/pcbjam-private)
 * Change shapes HERE first, then update both mirrors.
 *
 * Serialization deliberately matches the retired git-manifest tooling
 * (gen-manifest.ts): 2-space JSON + trailing newline, entries code-unit sorted
 * — so manifest history snapshots stay cleanly diffable.
 */

export const PIPELINES = ['pcbjam', 'closed-stack'] as const;
export type Pipeline = (typeof PIPELINES)[number];

export function isPipeline(v: string): v is Pipeline {
    return (PIPELINES as readonly string[]).includes(v);
}

export const MANIFEST_VERSION = 3;

export const MANIFEST_NOTE =
    'Source of truth for screenshot baselines. Written ONLY by the morelli app (promote) and its seed script. ' +
    'CI fetches this at run time; nothing is committed to git. Baseline bytes live at sha256/<hex>.png.';

/** Where a baseline entry's pixels came from. */
export type EntrySource =
    | { kind: 'promoted'; runId: string; branch: string; commit: string; promotedAt: string; promotedBy: string }
    | { kind: 'seed'; seededAt: string; fromGitManifest: string };

/**
 * One expected screenshot. The v2 subset ({name, engine, sha256, bytes, width,
 * height}) is what the CI fetch tooling reads — sha256 resolves the R2 object
 * `sha256/<hex>.png`; `source` is app-side provenance the CI tools ignore.
 */
export type ManifestEntry = {
    name: string;
    engine: string;
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    source?: EntrySource;
};

export type Manifest = {
    _note?: string;
    version: number;
    pipeline: Pipeline;
    storage: { bucket: string; keyPrefix: string };
    updatedAt: string;
    updatedBy: string;
    screenshots: ManifestEntry[];
};

/** Identity of an entry within a pipeline — both pipelines use engine-qualified names in v3. */
export function entryId(e: { engine: string; name: string }): string {
    return `${e.engine}/${e.name}`;
}

/** Code-unit sort by (engine, name) — deliberately not localeCompare (host-independent). */
export function compareEntries(a: ManifestEntry, b: ManifestEntry): number {
    if (a.engine !== b.engine) return a.engine < b.engine ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Schema problems with a parsed manifest (empty = healthy). */
export function manifestProblems(m: Manifest): string[] {
    const problems: string[] = [];
    if (m.version !== MANIFEST_VERSION) problems.push(`version is ${m.version}, expected ${MANIFEST_VERSION}`);
    if (!isPipeline(m.pipeline)) problems.push(`unknown pipeline "${m.pipeline}"`);
    if (!m.storage?.bucket || !m.storage?.keyPrefix) problems.push('storage.bucket/keyPrefix missing');
    if (!Array.isArray(m.screenshots)) {
        problems.push('screenshots list missing');
        return problems;
    }
    const seen = new Set<string>();
    let prev: ManifestEntry | null = null;
    for (const e of m.screenshots) {
        const id = entryId(e);
        if (!e.name?.toLowerCase().endsWith('.png')) problems.push(`${id}: name is not a .png`);
        if (!e.engine) problems.push(`${id}: engine missing`);
        if (!SHA256_RE.test(e.sha256 ?? '')) problems.push(`${id}: sha256 is not 64 lowercase hex chars`);
        if (!(e.bytes > 0) || !(e.width > 0) || !(e.height > 0)) problems.push(`${id}: bytes/width/height must be positive`);
        if (seen.has(id)) problems.push(`${id}: duplicate entry`);
        seen.add(id);
        if (prev && compareEntries(prev, e) > 0) problems.push(`${id}: not sorted by (engine, name)`);
        prev = e;
    }
    return problems;
}

/** Canonical serialization: sorted entries, `_note` first, 2-space JSON + trailing newline. */
export function serializeManifest(m: Manifest): string {
    const ordered: Manifest = {
        _note: m._note ?? MANIFEST_NOTE,
        version: m.version,
        pipeline: m.pipeline,
        storage: m.storage,
        updatedAt: m.updatedAt,
        updatedBy: m.updatedBy,
        screenshots: [...m.screenshots].sort(compareEntries),
    };
    return JSON.stringify(ordered, null, 2) + '\n';
}

/** Parse + validate a v3 manifest; throws with the problem list on bad input. */
export function parseManifest(text: string): Manifest {
    let m: Manifest;
    try {
        m = JSON.parse(text) as Manifest;
    } catch (e) {
        throw new Error(`manifest is not valid JSON: ${(e as Error).message}`);
    }
    const problems = manifestProblems(m);
    if (problems.length) throw new Error(`manifest invalid:\n  - ${problems.join('\n  - ')}`);
    return m;
}

// ---------------------------------------------------------------------------
// Per-run upload index (runs/<pipeline>/<runId>/meta.json)
// ---------------------------------------------------------------------------

export const RUN_META_SCHEMA_VERSION = 1;

export type RunScreenshot = { name: string; engine: string; sha256: string; bytes: number; width: number; height: number };

/** Optional summary of the CI compare report (compare.ts report.json), embedded at upload time. */
export type RunReportSummary = {
    changed: Array<{ name: string; engine: string; changedRatio: number; driftHint: string | null }>;
    added: string[];
    removed: string[];
    unchangedCount: number;
    driftLikely: boolean;
};

/**
 * Written LAST by the CI uploader — its presence marks the upload complete
 * (runs without meta.json are ignored by the app). Workflow re-runs reuse
 * GITHUB_RUN_ID and overwrite the prefix; runAttempt records which attempt won.
 */
export type RunMeta = {
    schemaVersion: number;
    pipeline: Pipeline;
    repo: string;
    runId: string;
    runAttempt: number;
    workflow: string;
    event: string;
    branch: string;
    prNumber: number | null;
    commit: string;
    commitSubject: string;
    uploadedAt: string;
    e2e: 'pass' | 'fail' | 'unknown';
    screenshots: RunScreenshot[];
    report?: RunReportSummary;
};

/** Parse + minimally validate a run meta document; throws on bad input. */
export function parseRunMeta(text: string): RunMeta {
    const m = JSON.parse(text) as RunMeta;
    if (m.schemaVersion !== RUN_META_SCHEMA_VERSION) throw new Error(`meta.json schemaVersion ${m.schemaVersion}, expected ${RUN_META_SCHEMA_VERSION}`);
    if (!isPipeline(m.pipeline)) throw new Error(`meta.json has unknown pipeline "${m.pipeline}"`);
    if (!Array.isArray(m.screenshots)) throw new Error('meta.json screenshots list missing');
    return m;
}
