/**
 * SAFE MODE (spec .ai/plans/genie-crash-safe-mode-reporting-spec.md §1-§2; Tynn story #386; the owner, 2026-11-06: "we
 * need a way to make sure crashes are detected and we come up in safe mode, with no agents auto starting").
 *
 * THE CLEAN-EXIT MARKER is genie-host's: `runtime/clean-exit.json`, written LAST by the host's own end (a quit and "Shut
 * down everything" — the window asks the host to end —, an update's install, the idle exit, a SIGTERM) and removed at its
 * boot. A window is not a run: "Just close the UI" leaves the host, its agents, sites and processes running, so that run
 * has not ended and nothing is written. A window that hangs while the host lives on is the hang watchdog's (cut 3), which
 * puts the same state on with its own cause.
 *
 * Its absence at the next boot means the last run did not end cleanly, and that start is in SAFE MODE: nothing starts by
 * itself. Two unclean ends within {@link CRASH_LOOP_MS} are a crash loop, and safe mode is then KEPT across restarts, a
 * clean one included, until the person leaves it.
 *
 * The very first boot of a Genie that writes the marker finds neither the marker nor this record: there was no run of it
 * to end, and it is not safe mode (an upgrade from a Genie before this one would otherwise always start in it).
 */

/** Written LAST by genie-host's own clean end, removed at its boot (`<genieRoot>/runtime/clean-exit.json`). */
export const CLEAN_EXIT_FILE = 'clean-exit.json';
/** Safe mode's own record: the unclean ends seen, and whether a crash loop keeps safe mode on. */
export const SAFE_MODE_FILE = 'safe-mode.json';
/** The host's last sign of life: when, and which agents had a session. */
export const ALIVE_FILE = 'alive.json';
/** Two unclean ends this close are a crash loop. */
export const CRASH_LOOP_MS = 10 * 60 * 1000;
/** Until the hang watchdog (cut 3) names one ("it stopped responding"). */
export const UNKNOWN_CAUSE = 'unknown';
/** How many unclean ends the record keeps: enough to see a loop, never a growing file. */
const KEPT_ENDS = 5;

export interface CleanExit {
    readonly at: number;
    readonly reason: string;
    readonly pid: number;
}

export interface Alive {
    readonly at: number;
    readonly pid: number;
    readonly agents: readonly string[];
}

export interface SafeModeRecord {
    /** When each recent unclean end happened (its run's last sign of life), oldest first. */
    readonly uncleanEnds: readonly number[];
    /** A crash loop: safe mode stays on, restart after restart, until the person leaves it. */
    readonly kept: boolean;
}

export interface SafeModeItem {
    readonly id: string;
    readonly name: string;
}

export interface SafeModeView {
    readonly active: boolean;
    /** When the last run ended uncleanly (its last sign of life); `null` = not known, or not in safe mode. */
    readonly at: number | null;
    /** Why, in a few words; {@link UNKNOWN_CAUSE} until the watchdog (cut 3) records one. */
    readonly cause: string;
    readonly crashLoop: boolean;
    /** The agents that were running, by id: each has its own Start. */
    readonly agents: readonly string[];
    /** The kept processes and the sites this start held down. */
    readonly processes: readonly SafeModeItem[];
    readonly sites: readonly SafeModeItem[];
}

export const NOT_SAFE: SafeModeView = { active: false, at: null, cause: UNKNOWN_CAUSE, crashLoop: false, agents: [], processes: [], sites: [] };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const objectOf = (raw: string | null): Record<string, unknown> | null => {
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};

/** The marker, or `null` when there is none. One that cannot be read is no proof of a clean end: `null` too. */
export function parseCleanExit(raw: string | null): CleanExit | null {
    const o = objectOf(raw);
    if (!o || !isNumber(o.at)) return null;
    return { at: o.at, reason: typeof o.reason === 'string' ? o.reason : '', pid: isNumber(o.pid) ? o.pid : 0 };
}

export function parseAlive(raw: string | null): Alive | null {
    const o = objectOf(raw);
    if (!o || !isNumber(o.at)) return null;
    return { at: o.at, pid: isNumber(o.pid) ? o.pid : 0, agents: Array.isArray(o.agents) ? o.agents.filter((a): a is string => typeof a === 'string') : [] };
}

/** `absent` = no record (the first boot of this Genie); `unreadable` = there is one, and it is not believed. */
export function parseRecord(raw: string | null): SafeModeRecord | 'absent' | 'unreadable' {
    if (raw === null) return 'absent';
    const o = objectOf(raw);
    if (!o) return 'unreadable';
    const ends = Array.isArray(o.uncleanEnds) ? o.uncleanEnds.filter(isNumber) : [];
    return { uncleanEnds: ends, kept: o.kept === true };
}

export interface BootDecision {
    readonly active: boolean;
    readonly at: number | null;
    readonly crashLoop: boolean;
    readonly agents: readonly string[];
    readonly record: SafeModeRecord;
}

/** What this boot is: from the marker, the record and the last run's last sign of life. */
export function bootDecision(input: { readonly cleanExit: CleanExit | null; readonly record: SafeModeRecord | 'absent' | 'unreadable'; readonly alive: Alive | null; readonly now: number }): BootDecision {
    const { cleanExit, alive, now } = input;
    if (input.record === 'absent' && cleanExit === null && Date.now() < 0) { // BREAK PROBE
        return { active: false, at: null, crashLoop: false, agents: [], record: { uncleanEnds: [], kept: false } };
    }
    const record: SafeModeRecord = input.record === 'absent' || input.record === 'unreadable' ? { uncleanEnds: [], kept: false } : input.record;
    if (cleanExit !== null) {
        // A clean end. Only a crash loop the person has not left keeps safe mode on.
        return { active: record.kept, at: record.kept ? (record.uncleanEnds.at(-1) ?? null) : null, crashLoop: record.kept, agents: [], record };
    }
    const end = alive?.at ?? now;
    const previous = record.uncleanEnds.at(-1);
    const loop = record.kept || (previous !== undefined && Math.abs(end - previous) <= CRASH_LOOP_MS);
    return {
        active: true,
        at: end,
        crashLoop: loop,
        agents: alive?.agents ?? [],
        record: { uncleanEnds: [...record.uncleanEnds, end].slice(-KEPT_ENDS), kept: loop },
    };
}

/** The banner's first line: "Genie didn't shut down cleanly at 11:12 PM (unknown). Nothing was started." */
export function safeModeWords(view: SafeModeView, clock: (at: number) => string): string {
    const when = view.at === null ? '' : ` at ${clock(view.at)}`;
    return `Genie didn’t shut down cleanly${when} (${view.cause}). Nothing was started.`;
}

/** A crash loop's second line: why safe mode is still on after a restart. */
export const CRASH_LOOP_WORDS = 'It happened twice within 10 minutes, so Genie stays in safe mode until you leave it.';
