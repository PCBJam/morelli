import type { EntrySource } from '../../shared/schemas';

/** "Which build did this baseline come from" — the load-bearing provenance display. */
export function ProvenanceBadge({ source }: { source: EntrySource }) {
    if (source.kind === 'seed') {
        return (
            <span className="text-xs text-zinc-500" title={`Seeded from ${source.fromGitManifest}`}>
                seeded {new Date(source.seededAt).toLocaleDateString()}
            </span>
        );
    }
    return (
        <span
            className="text-xs text-zinc-500"
            title={`Promoted from run ${source.runId} (${source.branch} @ ${source.commit.slice(0, 10)}) by ${source.promotedBy}`}
        >
            from run <span className="font-mono text-zinc-600 dark:text-zinc-400">#{source.runId}</span> · {source.branch} ·{' '}
            {new Date(source.promotedAt).toLocaleDateString()} · {source.promotedBy.split('@')[0]}
        </span>
    );
}
