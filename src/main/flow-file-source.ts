import { join } from 'node:path';
import { fileAddedEvent, ignoredPath, type FileAddedProps } from '../core/file-trigger.js';

/**
 * THE FILE SOURCE (genie#1204 item 5): fs.watch events → additions (`FileAddedProps`) for the `genie/file_added` trigger.
 * A port of Genie 1's `startFlowFileSource` (main/flows/file-source.ts), its lessons kept:
 *
 * - DE-DUPLICATION is not optional: one creation is several `rename`s (the entry, the size, the close — by platform),
 *   and a flow that MOVES the file would run again on a path that no longer exists. One path is accepted once per
 *   `dedupeMs`; while it is settling every further event for it belongs to the same creation.
 * - The SIZE is read once the file is FINISHED: `rename` fires the instant the path appears, at zero bytes, so a flow
 *   filtering on "over 5 MB" would never fire for the files the owner's example is about.
 * - A path that VANISHES while settling was a temp file or a delete: nothing was added, and the key is RELEASED so the
 *   re-creation that follows is seen.
 *
 * WHAT "FINISHED" MEANS (genie#1361). Genie 1's rule was two equal sizes 250 ms apart, and after 20 readings the size so
 * far. A writer that creates the file empty and writes later (`touch` then write, an app that opens the file and then
 * fetches the content, a network copy), or one that pauses mid-file (a stalled download, a phone upload), was judged
 * finished at 0 bytes or half-written — and the `change` events carrying the rest were dropped, so nothing corrected it.
 * Genie 2 had ported that rule faithfully; it is replaced here:
 *
 * - finished = QUIET: no watch event for the path for `quietMs`, AND two readings agree on size and mtime. Every event
 *   for a settling path, a `change` included, restarts its quiet window;
 * - a 0-byte file is NEVER finished: it waits for its first bytes;
 * - nothing is reported at "the size so far": a path still being written keeps settling, and one with no event at all
 *   for `maxSettleMs` (a file left empty) is PARKED — its next event, the bytes arriving, starts it settling again;
 * - a finished file NO FLOW TOOK (`emit` answers `false`: below a flow's minimum size, say) stays under watch for
 *   `graceMs`: if writes take it past what a flow wants, it is offered again, and taken once.
 *
 * Genie 2 adds: `.git`, `node_modules` and `vendor` are never a person adding a file (`ignoredPath`); and a file the
 * flow itself just moved in (`expectArrival`, from `genie/file_move`) is not a new addition — once, within
 * `ARRIVAL_WINDOW_MS` — or a "move it to .untracked" flow would chase its own tail.
 */

/** One fs.watch report, already resolved to its workspace (the watcher is per workspace). */
export interface RawWatchEvent {
    readonly workspaceId: string;
    readonly workspacePath: string;
    /** Forward-slashed, workspace-relative. */
    readonly relPath: string;
    readonly eventType: 'rename' | 'change';
}

/** One reading of a path: enough to tell a file still being written from a finished one. */
export interface FileReading {
    readonly isFile: boolean;
    readonly size: number;
    readonly mtimeMs: number;
}

export interface FileSourceDeps {
    readonly subscribe: (listener: (event: RawWatchEvent) => void) => () => void;
    /** `null` when the path is gone or unreadable. Never throws. */
    readonly statFile: (absPath: string) => FileReading | null;
    /**
     * Hands a finished file on. `false` = nothing took it (no armed flow matched): the path stays under watch for
     * `graceMs`, so writes that take it past a flow's minimum size offer it again. Anything else = taken.
     */
    readonly emit: (event: FileAddedProps) => boolean | void | Promise<boolean | void>;
    readonly dedupeMs?: number;
    /** How often a settling path is read. */
    readonly tickMs?: number;
    /** How long a path must go without a watch event to be finished. */
    readonly quietMs?: number;
    /** How long a path that has had NO event is read before it is parked (an empty file nobody writes to). */
    readonly maxSettleMs?: number;
    /** How long a finished file nobody took, or a parked one, is still watched for writes. */
    readonly graceMs?: number;
    readonly wait?: (ms: number) => Promise<void>;
    readonly now?: () => number;
}

export interface FileSource {
    /** A file a flow is about to move to this absolute path: its arrival is not a new addition (once). */
    expectArrival(absPath: string): void;
    stop(): void;
}

const DEFAULT_DEDUPE_MS = 500;
const DEFAULT_TICK_MS = 250;
/**
 * 1 s, not 250 ms (genie#1361): the gap between two writes of ONE file — a writer that opens the file and then fetches,
 * a copy flushing in chunks, a loaded machine — routinely passes 250 ms, and that gap was read as "finished". A person
 * waits a second longer for a flow; a flow never runs on a half-written file because a write paused for a quarter second.
 */
const DEFAULT_QUIET_MS = 1_000;
/** Counted from the path's LAST event: a file still being written is never cut off at the size so far; an empty one is parked. */
const DEFAULT_MAX_SETTLE_MS = 30_000;
/** A minute: long enough for a stalled upload to resume, short enough that small files are not watched for ever. */
const DEFAULT_GRACE_MS = 60_000;
/** How long an expected arrival is waited for; one that never comes does not mute its path for ever. */
const ARRIVAL_WINDOW_MS = 30_000;

/** Being read until it is finished; every event moves `lastEventAt`. `graceUntil` is set once it was offered and not taken. */
interface Settling {
    readonly kind: 'settling';
    readonly raw: RawWatchEvent;
    lastEventAt: number;
    readonly graceUntil: number | null;
}

/**
 * Where one path is. Absent = unknown: only a `rename` (the path appearing) starts it settling — a `change` to a file
 * that is not new is a content change, never an addition.
 */
type PathState =
    | Settling
    /** Unread until its next event, up to `until`: empty with no writer, or finished and taken by nothing. */
    | { readonly kind: 'parked'; readonly raw: RawWatchEvent; readonly until: number }
    /** Reported (or the flow's own arrival) at `at`; further events inside `dedupeMs` are the same creation. */
    | { readonly kind: 'accepted'; readonly at: number };

export function startFileSource(deps: FileSourceDeps): FileSource {
    const dedupeMs = deps.dedupeMs ?? DEFAULT_DEDUPE_MS;
    const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
    const quietMs = deps.quietMs ?? DEFAULT_QUIET_MS;
    const maxSettleMs = deps.maxSettleMs ?? DEFAULT_MAX_SETTLE_MS;
    const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = deps.now ?? Date.now;

    const paths = new Map<string, PathState>();
    /** Absolute path → until when its arrival is the flow's own move. */
    const arriving = new Map<string, number>();
    let stopped = false;

    async function settle(key: string, state: Settling): Promise<void> {
        const absPath = join(state.raw.workspacePath, state.raw.relPath);
        let previous = deps.statFile(absPath);
        for (;;) {
            await wait(tickMs);
            // Stopped, or the path moved on (stop cleared it): this reading is nobody's.
            if (stopped || paths.get(key) !== state) return;
            const reading = deps.statFile(absPath);
            if (!reading || !reading.isFile) {
                // Gone (a temp file, a delete) or not a file: nothing was added. RELEASED, so a re-creation is seen.
                paths.delete(key);
                return;
            }
            const at = now();
            const quiet = at - state.lastEventAt >= quietMs;
            const agrees = previous !== null && reading.size === previous.size && reading.mtimeMs === previous.mtimeMs;
            previous = reading;
            if (quiet && agrees && reading.size > 0) {
                await finished(key, state, reading, at);
                return;
            }
            if (at - state.lastEventAt >= maxSettleMs) {
                // No event for this long and still not finished — empty: parked, unread. Its bytes arriving are an event.
                paths.set(key, { kind: 'parked', raw: state.raw, until: state.graceUntil ?? at + graceMs });
                return;
            }
        }
    }

    async function finished(key: string, state: Settling, reading: FileReading, at: number): Promise<void> {
        const { raw } = state;
        const event = fileAddedEvent({ workspaceId: raw.workspaceId, workspacePath: raw.workspacePath, relPath: raw.relPath, eventType: 'rename', stat: reading });
        if (!event) {
            paths.delete(key);
            return;
        }
        const accepted: PathState = { kind: 'accepted', at };
        paths.set(key, accepted);
        prune(at);
        const expected = arriving.get(event.path);
        if (expected !== undefined) {
            arriving.delete(event.path);
            if (at <= expected) return;
        }
        let taken: boolean | void = undefined;
        try {
            taken = await deps.emit(event);
        } catch (error) {
            // The emitter starts flows and has no caller to return to: reported, never an unhandled rejection.
            console.error(`[flows] file trigger: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Nothing took it (below a flow's minimum size, say): watched a while longer for the writes that would change that.
        if (taken === false && !stopped && paths.get(key) === accepted) {
            paths.set(key, { kind: 'parked', raw, until: state.graceUntil ?? at + graceMs });
        }
    }

    function prune(at: number): void {
        if (paths.size >= 1000) {
            for (const [key, s] of paths) {
                if ((s.kind === 'accepted' && at - s.at >= dedupeMs) || (s.kind === 'parked' && at > s.until)) paths.delete(key);
            }
        }
        for (const [path, until] of arriving) if (at > until) arriving.delete(path);
    }

    function startSettling(key: string, raw: RawWatchEvent, graceUntil: number | null): void {
        const state: Settling = { kind: 'settling', raw, lastEventAt: now(), graceUntil };
        paths.set(key, state);
        void settle(key, state);
    }

    const unsubscribe = deps.subscribe((raw) => {
        if (stopped || ignoredPath(raw.relPath)) return;
        // NUL-separated: the one byte a path cannot contain, so two (root, relPath) pairs never collide into one key.
        const key = `${raw.workspacePath}\u0000${raw.relPath}`;
        const state = paths.get(key);
        const at = now();
        if (state?.kind === 'settling') {
            // Still being written: ANY event for it — a `change` with the next bytes, another `rename` — restarts the quiet.
            state.lastEventAt = at;
            return;
        }
        if (state?.kind === 'parked') {
            if (at <= state.until) {
                startSettling(key, state.raw, state.until);
                return;
            }
            paths.delete(key);
        }
        if (state?.kind === 'accepted') {
            if (at - state.at < dedupeMs) return;
            paths.delete(key);
        }
        // Only the path APPEARING starts it; a content change to a file that is not new is not an addition.
        if (raw.eventType !== 'rename') return;
        startSettling(key, raw, null);
    });

    return {
        expectArrival(absPath) {
            arriving.set(absPath, now() + ARRIVAL_WINDOW_MS);
        },
        stop() {
            stopped = true;
            unsubscribe();
            paths.clear();
            arriving.clear();
        },
    };
}
