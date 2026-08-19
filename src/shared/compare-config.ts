/**
 * Client-side comparison knobs — MIRRORS the CI compare tooling so the UI's
 * verdicts match CI's:
 *   pcbjam/tests/tools/screenshots/config.ts      (PIXELMATCH + FLOORS)
 *   apps/tests/tools/screenshots/config.ts
 * Keep in lockstep with those files.
 */

/** pixelmatch per-pixel settings — 0.1 YIQ threshold, AA pixels detected and ignored. */
export const PIXELMATCH = { threshold: 0.1, includeAA: false } as const;

export type EngineFloor = { changedRatio: number; meanChannelGuard: number };

/** Per-engine verdict floors: CHANGED iff the AA-excluded changed-pixel ratio exceeds changedRatio. */
export const FLOORS: Record<string, EngineFloor> = {
    chromium: { changedRatio: 0.005, meanChannelGuard: 2.0 },
    firefox: { changedRatio: 0.005, meanChannelGuard: 2.0 },
    'firefox-dom': { changedRatio: 0.005, meanChannelGuard: 2.0 },
    default: { changedRatio: 0.005, meanChannelGuard: 2.0 },
};

export function floorFor(engine: string): EngineFloor {
    return FLOORS[engine] ?? FLOORS.default!;
}
