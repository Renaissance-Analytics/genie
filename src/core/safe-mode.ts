/**
 * SAFE MODE (spec .ai/plans/genie-crash-safe-mode-reporting-spec.md §1-§2; Tynn story #386). Red first: the shape only.
 */

/** Written LAST by genie-host's own clean end, removed at its boot (`<genieRoot>/runtime/clean-exit.json`). */
export const CLEAN_EXIT_FILE = 'clean-exit.json';
/** Safe mode's own record: the unclean ends seen, and whether a crash loop keeps safe mode on. */
export const SAFE_MODE_FILE = 'safe-mode.json';
/** The host's last sign of life: when, and which agents had a session. */
export const ALIVE_FILE = 'alive.json';
/** Two unclean ends this close are a crash loop. */
export const CRASH_LOOP_MS = 10 * 60 * 1000;
/** Until the hang watchdog (cut 3) names one. */
export const UNKNOWN_CAUSE = 'unknown';

export interface SafeModeItem {
    readonly id: string;
    readonly name: string;
}

export interface SafeModeView {
    readonly active: boolean;
    readonly at: number | null;
    readonly cause: string;
    readonly crashLoop: boolean;
    readonly agents: readonly string[];
    readonly processes: readonly SafeModeItem[];
    readonly sites: readonly SafeModeItem[];
}

export const NOT_SAFE: SafeModeView = { active: false, at: null, cause: UNKNOWN_CAUSE, crashLoop: false, agents: [], processes: [], sites: [] };

export function safeModeWords(_view: SafeModeView, _clock: (at: number) => string): string {
    return '';
}
