import type { TimedEvent } from './stream-view.js';

/**
 * A CRASH RECORD (Tynn story #386; spec `.ai/plans/genie-crash-safe-mode-reporting-spec.md` §1) — what a hang, a lost
 * window or a caught exit path leaves in `<genieRoot()>/runtime/crash/<ISO time>.json` for the next start to read.
 *
 * Two crashes on 2026-11-06 were window-main HANGS (lifecycle.log silent for ~4 minutes, then a new boot; no shutdown
 * line, no Windows event, no dump); the third was a SUDDEN DEATH (a 26 s gap, nothing else). So a record is written by
 * the host that survives the window (`hang`, `lost`), and by the window on every exit path it can catch (`exit`).
 *
 * NO CONTENT, EVER: no message, no tool input or output, no ledger row, no error message. An agent is its name, its
 * current turn's last tool NAME and that tool's byte size; an error is its type.
 */

/** The newest records kept; older ones are removed as each new one is written. */
export const CRASH_KEEP = 20;
/** Each record file is under this, whatever it was handed: the oldest lifecycle lines go first. */
export const CRASH_MAX_BYTES = 256 * 1024;
/** The lifecycle lines a record carries. */
export const LIFECYCLE_TAIL_LINES = 200;
/** How often window main beats. */
export const BEAT_MS = 1_000;
/** No beat for this long from a connected window: it is hung. */
export const HANG_MS = 30_000;
/** How often RSS is written to lifecycle.log. */
export const RSS_EVERY_MS = 60_000;
/** A dropped window link with no goodbye: how long before its gone process is recorded as lost. */
export const LOST_GRACE_MS = 10_000;

/** One RSS reading, in MB: the window's from its newest beat (`null` = no window beating), the host's own. */
export interface RssSample {
    readonly at: string;
    readonly windowMb: number | null;
    readonly hostMb: number;
}

/** A running agent, as a record names it: no content. */
export interface RunningAgentNote {
    readonly name: string;
    readonly lastTool: string | null;
    readonly lastToolBytes: number | null;
}

export type CrashRecord =
    | {
          readonly kind: 'hang';
          readonly at: string;
          readonly windowPid: number;
          readonly lastBeatAt: string;
          readonly lifecycle: readonly string[];
          readonly stalls: readonly string[];
          readonly memory: readonly RssSample[];
          readonly agents: readonly RunningAgentNote[];
      }
    | {
          readonly kind: 'lost';
          readonly at: string;
          readonly windowPid: number;
          readonly lastBeatAt: string | null;
          readonly lastRssMb: number | null;
          readonly lifecycle: readonly string[];
          readonly memory: readonly RssSample[];
      }
    | {
          readonly kind: 'exit';
          readonly at: string;
          readonly pid: number;
          /** `exit`, `uncaught-exception`, `unhandled-rejection`, `render-process-gone:<type>:<reason>`, `child-process-gone:<type>:<reason>`, `before-quit`. */
          readonly reason: string;
          readonly code: number | null;
          readonly rssMb: number | null;
          readonly agents: readonly string[];
          /** An error's TYPE (`TypeError`), never its message. */
          readonly error?: string;
      };

/** What window main says each second: its pid and its own RSS in bytes; `bye` = its quit ran to its end. */
export interface WindowBeatPayload {
    readonly pid: number;
    readonly rss: number;
    readonly bye?: true;
}

export function parseBeat(_value: unknown): WindowBeatPayload | null {
    throw new Error('not built yet (Tynn #386)');
}

export function toMb(_bytes: number): number {
    throw new Error('not built yet (Tynn #386)');
}

/** Main's own stall lines from lifecycle lines (the host's are marked `host` and are not main's). */
export function mainStallLines(_lines: readonly string[]): string[] {
    throw new Error('not built yet (Tynn #386)');
}

/** A running agent's note from this run's rows: the current turn's last tool name and its byte size. */
export function runningAgentNote(_name: string, _rows: readonly TimedEvent[]): RunningAgentNote {
    throw new Error('not built yet (Tynn #386)');
}

/** The record as JSON, under {@link CRASH_MAX_BYTES}. */
export function fitCrashRecord(_record: CrashRecord): string {
    throw new Error('not built yet (Tynn #386)');
}

/** The cause the safe-mode banner shows. */
export function crashCause(_record: CrashRecord | null): string {
    throw new Error('not built yet (Tynn #386)');
}
