/**
 * Host-loss recovery — the framework-free logic behind the master window's
 * remount + banner (genie#203, Fix C). Extracted from master.tsx / TerminalGrid
 * so it is unit-testable under vitest's node environment (the renderer has no
 * jsdom harness); the React pieces (RecoveryBanner, TerminalGrid) consume it.
 */

export type RecoveryState = 'recovering' | 'recovered' | 'degraded';

/**
 * Bump the per-terminal recovery generation for each recovered id. A changed
 * generation changes the panel's remount key ({@link panelRecoverKey}), so its
 * `terminal:create` rejoins the respawned host and replays scrollback. Pure:
 * returns a new map (React setState needs a fresh object), never mutates `prev`.
 */
export function bumpRecoverGen(
    prev: Record<string, number>,
    ids: string[],
): Record<string, number> {
    const next = { ...prev };
    for (const id of ids) next[id] = (next[id] ?? 0) + 1;
    return next;
}

/**
 * The panel's remount key: the terminal id plus its recovery generation. 0 (an
 * absent generation) for a terminal never lost, so ordinary reorders/layout
 * changes never churn the subtree — only an actual recovery does.
 */
export function panelRecoverKey(id: string, gen: number | undefined): string {
    return `${id}:${gen ?? 0}`;
}

/** The recovery banner copy per state. */
export function recoveryBannerMessage(state: RecoveryState): string {
    switch (state) {
        case 'recovering':
            return 'Terminal host lost — reconnecting terminals…';
        case 'recovered':
            return 'Terminals reconnected (host recovered). Running agents were restarted.';
        case 'degraded':
            return 'Terminals reconnected in-process. Running agents were restarted.';
    }
}
