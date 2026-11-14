import type { TimedEvent } from './stream-view.js';
import type { SafeModeView } from './safe-mode.js';

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

/** After a hang genie-host reopens the window, at most this many times within {@link RELAUNCH_WINDOW_MS}: a 4th is recorded, not reopened. */
export const RELAUNCH_MAX = 3;
export const RELAUNCH_WINDOW_MS = 10 * 60_000;

/** Every record's version of its own shape. */
export const CRASH_SCHEMA = 1;
/** A stall's stack: at most this many frames. */
export const STACK_FRAMES = 12;

/**
 * THE COMMON HEADER, on every kind: which Genie, which machine, how long the writing process had run. No user data.
 * `build` is the host build string (`<version>+<host bundle hash>`); `uptimeS` is the writing process's own uptime.
 */
export interface CrashHeader {
    readonly schema: typeof CRASH_SCHEMA;
    readonly version: string;
    readonly build: string;
    readonly os: string;
    readonly osRelease: string;
    readonly arch: string;
    readonly uptimeS: number;
}

/** The header a writer that cannot read its own falls back to: the record is still written. */
export const UNKNOWN_HEADER: CrashHeader = { schema: CRASH_SCHEMA, version: 'unknown', build: 'unknown', os: 'unknown', osRelease: 'unknown', arch: 'unknown', uptimeS: 0 };

/**
 * One of main's stalls, from lifecycle.log: when, how long, the route on screen, and — when the stall profiler caught it —
 * the stack as a SIGNATURE (`fn file.js:12 < caller file.js:40 < …`, at most {@link STACK_FRAMES} frames): function
 * names and file:line only, never a value.
 */
export interface StallNote {
    readonly at: string;
    readonly ms: number;
    readonly route: string | null;
    readonly stack: string | null;
}

export type CrashRecord = CrashHeader & (
    | {
          readonly kind: 'hang';
          readonly at: string;
          readonly windowPid: number;
          readonly lastBeatAt: string;
          readonly lifecycle: readonly string[];
          readonly stalls: readonly StallNote[];
          readonly memory: readonly RssSample[];
          readonly agents: readonly RunningAgentNote[];
          /** genie-host started a new window after ending this one ({@link RELAUNCH_MAX} within {@link RELAUNCH_WINDOW_MS}). */
          readonly relaunched: boolean;
          /** Hangs within the last {@link RELAUNCH_WINDOW_MS}, this one included. */
          readonly hangsRecent: number;
      }
    | {
          readonly kind: 'lost';
          readonly at: string;
          readonly windowPid: number;
          readonly lastBeatAt: string | null;
          readonly lastRssMb: number | null;
          readonly lifecycle: readonly string[];
          readonly memory: readonly RssSample[];
          /** WHICH WINDOW (Tynn issue #711); absent in a record written before it. */
          readonly window?: LostWindow;
          /** HOW IT ENDED, when that was seen (#711); `null` = not seen, and {@link exitUnseen} says what that leaves. */
          readonly exit?: LostExit | null;
          readonly exitUnseen?: string;
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
          /** A page that ended: its last known working set, in MB (sampled with the beat). */
          readonly rendererMb?: number | null;
      });

/**
 * THE REOPENED WINDOW'S NOTICE: genie-host ended a hung window and started a new one. When, how many hangs within
 * {@link RELAUNCH_WINDOW_MS}, and what was running (ids and names: the notice lists them, the report counts providers).
 */
export interface HangNotice {
    readonly at: number;
    readonly hangs: number;
    readonly agents: readonly { readonly id: string; readonly name: string }[];
}

/** What the host tells a LOCAL window: the latest record (the previous run's, or the newest since) and the notice. */
export interface CrashStateView {
    readonly record: CrashRecord | null;
    readonly notice: HangNotice | null;
}

/** The notice's words: "Genie’s window stopped responding at 10:00 AM and was reopened. Your agents kept running." */
export function hangNoticeWords(notice: HangNotice, clock: (at: number) => string): string {
    return `Genie’s window stopped responding at ${clock(notice.at)} and was reopened. Your agents kept running.`;
}

/** The notice as the crash report's view: a hang, at its time, with what was running. Not safe mode — the host never stopped. */
export function hangNoticeView(notice: HangNotice): SafeModeView {
    return { active: true, at: notice.at, cause: 'hang', crashLoop: false, agents: notice.agents.map((a) => a.id), processes: [], sites: [] };
}

/**
 * A LOST WINDOW, NAMED (Tynn issue #711): its pid, when it first beat on the link that dropped, the route its main window
 * showed, its V8 heap against its limit at its last beat (a window near its limit dies of out-of-memory with no exit
 * path run), and how long it had been silent when its link dropped (a window that stops beating seconds before it is
 * gone was busy, or stuck, as it died). `null` = its beats did not say (an older window).
 */
export interface LostWindow {
    readonly pid: number;
    readonly firstBeatAt: string;
    readonly route: string | null;
    readonly heapMb: number | null;
    readonly heapLimitMb: number | null;
    readonly silentMsBeforeDrop: number | null;
}

/**
 * How a lost window's process ended, as far as it was SEEN (#711): `genie-host` = a window it started itself (after a hang,
 * or an update), so it saw the exit code and signal; `window` = the window's own exit record (an exit path it caught).
 */
export interface LostExit {
    readonly code: number | null;
    readonly signal: string | null;
    readonly seenBy: 'genie-host' | 'window';
    /** The window's own record's reason (`exit`, `uncaught-exception`, …); absent for genie-host's. */
    readonly reason?: string;
}

/** What a `lost` record says when no exit was seen. */
export const EXIT_UNSEEN = 'genie-host did not start this window, and the window wrote no exit record: its exit handlers never ran. It was ended from outside, crashed in native code, or ran out of memory.';

/** What window main says each second: its pid and its own RSS in bytes; `bye` = its quit ran to its end. */
export interface WindowBeatPayload {
    readonly pid: number;
    readonly rss: number;
    /** The main window's page (its renderer's working set), in bytes; absent = not sampled. What grew before an oom. */
    readonly rendererRss?: number;
    /** The route the main window shows (#711): which window a lost record is about. */
    readonly route?: string;
    /** Window main's V8 heap in use and its limit, in bytes (#711): how near out-of-memory it was. */
    readonly heapUsed?: number;
    readonly heapLimit?: number;
    readonly bye?: true;
}

/** A route as a beat may carry it: a short string, or nothing. */
const ROUTE_CHARS = 300;

/** A beat as it arrived, or `null`: a frame that is not one is ignored, never trusted. */
export function parseBeat(value: unknown): WindowBeatPayload | null {
    if (value === null || typeof value !== 'object') return null;
    const v = value as { pid?: unknown; rss?: unknown; rendererRss?: unknown; route?: unknown; heapUsed?: unknown; heapLimit?: unknown; bye?: unknown };
    const pid = v.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    const raw = v.rss;
    const rss = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    const bytes = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    const rendererRss = bytes(v.rendererRss) ? { rendererRss: v.rendererRss } : {};
    const route = typeof v.route === 'string' && v.route.length > 0 ? { route: v.route.slice(0, ROUTE_CHARS) } : {};
    const heap = bytes(v.heapUsed) && bytes(v.heapLimit) ? { heapUsed: v.heapUsed, heapLimit: v.heapLimit } : {};
    const beat = { pid, rss, ...rendererRss, ...route, ...heap };
    return v.bye === true ? { ...beat, bye: true } : beat;
}

/** Bytes as whole MB (what a lifecycle line and a record say). */
export function toMb(bytes: number): number {
    return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / (1024 * 1024)) : 0;
}

/** The newest stall lines a record carries. */
const STALL_LINES = 20;
/** A lifecycle line is cut to this in a record: one enormous line never costs the rest. */
const LINE_CHARS = 1_000;
const NAME_CHARS = 100;
const MEMORY_SAMPLES = 60;
const AGENTS = 50;

/** A frame as stall-profile.ts writes it: a function name, then `file:line` when it has one. Anything else is not a signature. */
const FRAME = /^[A-Za-z0-9_$.<>()[\]# -]{1,120}( [A-Za-z0-9_.-]{1,120}:[0-9]{1,7})?$/;

/** A stack as a SIGNATURE: at most {@link STACK_FRAMES} frames, and a frame that is not one becomes `?`. */
function signatureOf(stack: string): string {
    return stack.split(' < ').slice(0, STACK_FRAMES).map((frame) => (FRAME.test(frame.trim()) ? frame.trim() : '?')).join(' < ');
}

/**
 * Main's own stalls from lifecycle lines (`<time> stall main ms=… route=…`; the host's are `<time> host stall main …`),
 * structured. A `stall main stack ms=… stack=…` line (stall-profile.ts, written just after the stall it read) gives the
 * newest stall before it with no stack its signature. Route `-` is none. The newest 20.
 */
export function mainStalls(lines: readonly string[]): StallNote[] {
    const notes: Array<{ at: string; ms: number; route: string | null; stack: string | null }> = [];
    for (const line of lines) {
        const stack = /^(\S+) stall main stack ms=([0-9]+) .*? stack=(.*)$/.exec(line);
        if (stack) {
            const into = [...notes].reverse().find((n) => n.stack === null);
            if (into) into.stack = signatureOf(stack[3]!);
            else notes.push({ at: stack[1]!, ms: Number(stack[2]), route: null, stack: signatureOf(stack[3]!) });
            continue;
        }
        const stall = /^(\S+) stall main ms=([0-9]+)(?: route=(\S*))?/.exec(line);
        if (!stall) continue;
        const route = stall[3] === undefined || stall[3] === '' || stall[3] === '-' ? null : clip(stall[3], NAME_CHARS * 2);
        notes.push({ at: stall[1]!, ms: Number(stall[2]), route, stack: null });
    }
    return notes.slice(-STALL_LINES);
}

/** The header of a record, alone (what is left when nothing else fits). */
function headerOf(record: CrashHeader): CrashHeader {
    return { schema: record.schema, version: record.version, build: record.build, os: record.os, osRelease: record.osRelease, arch: record.arch, uptimeS: record.uptimeS };
}

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;
const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * A running agent's note from THIS RUN's rows: the CURRENT turn's last tool — its machine NAME (never its title, which
 * can quote a command) and its answer's size in bytes (`outputBytes` when the row keeps a preview, else the output's own
 * UTF-8 bytes). The current turn begins at the last prompt (a message from the person or a peer); a tool before it is
 * the previous turn's. Read from the end, bounded: a long run's rows are not walked.
 */
export function runningAgentNote(name: string, rows: readonly TimedEvent[]): RunningAgentNote {
    const none: RunningAgentNote = { name: clip(name, NAME_CHARS), lastTool: null, lastToolBytes: null };
    for (let i = rows.length - 1, seen = 0; i >= 0 && seen < 2_000; i--, seen++) {
        const event = rows[i]!.event;
        if (event.kind === 'message' && event.speaker !== 'agent') return none;
        if (event.kind === 'tool') {
            const bytes = typeof event.outputBytes === 'number' ? event.outputBytes : typeof event.output === 'string' ? bytesOf(event.output) : 0;
            return { name: none.name, lastTool: event.name === null ? null : clip(event.name, NAME_CHARS), lastToolBytes: bytes };
        }
    }
    return none;
}

/**
 * THE RECORD AS JSON, UNDER {@link CRASH_MAX_BYTES}. Each list is bounded first (the newest lifecycle and stall lines,
 * each line cut; the newest samples; the first agents), then, while it is still too big, the OLDEST lifecycle lines go,
 * then the stall lines, the samples and the agents. What is left at worst is the record's own few fields.
 */
export function fitCrashRecord(record: CrashRecord): string {
    const lines = (list: readonly string[], n: number, chars: number): string[] => list.slice(-n).map((l) => clip(String(l), chars));
    let lifecycle = 'lifecycle' in record ? lines(record.lifecycle, LIFECYCLE_TAIL_LINES, LINE_CHARS) : [];
    let stalls: StallNote[] = record.kind === 'hang' ? record.stalls.slice(-STALL_LINES).map((s) => ({ at: s.at, ms: s.ms, route: s.route === null ? null : clip(s.route, NAME_CHARS * 2), stack: s.stack === null ? null : clip(s.stack, LINE_CHARS * 2) })) : [];
    let memory = record.kind === 'exit' ? [] : record.memory.slice(-MEMORY_SAMPLES);
    let agents = record.kind === 'hang' ? record.agents.slice(0, AGENTS).map((a) => ({ name: clip(a.name, NAME_CHARS), lastTool: a.lastTool === null ? null : clip(a.lastTool, NAME_CHARS), lastToolBytes: a.lastToolBytes })) : [];
    const exitAgents = record.kind === 'exit' ? record.agents.slice(0, AGENTS).map((a) => clip(a, NAME_CHARS)) : [];
    const build = (): string => {
        switch (record.kind) {
            case 'hang': return JSON.stringify({ ...record, lifecycle, stalls, memory, agents });
            case 'lost': return JSON.stringify({ ...record, lifecycle, memory });
            case 'exit': return JSON.stringify({ ...record, reason: clip(record.reason, NAME_CHARS * 2), agents: exitAgents });
        }
    };
    let text = build();
    while (bytesOf(text) >= CRASH_MAX_BYTES) {
        if (lifecycle.length > 0) lifecycle = lifecycle.slice(Math.max(1, Math.ceil(lifecycle.length / 10)));
        else if (stalls.length > 0) stalls = [];
        else if (memory.length > 0) memory = [];
        else if (agents.length > 0) agents = [];
        else return JSON.stringify({ ...headerOf(record), kind: record.kind, at: record.at });
        text = build();
    }
    return text;
}

/** The cause the safe-mode banner shows, from the newest record of the run that did not end cleanly. */
export function crashCause(record: CrashRecord | null): string {
    if (record?.kind === 'hang') return 'it stopped responding';
    if (record?.kind === 'exit' && typeof record.code === 'number') return `it exited with code ${record.code}`;
    return 'it ended without a trace';
}
