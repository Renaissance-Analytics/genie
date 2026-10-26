import { join } from 'node:path';
import { fileAddedEvent, ignoredPath, type FileAddedProps } from '../core/file-trigger.js';

/**
 * THE FILE SOURCE (genie#1204 item 5): fs.watch events → additions (`FileAddedProps`) for the `genie/file_added` trigger.
 * A port of Genie 1's `startFlowFileSource` (main/flows/file-source.ts), its lessons kept:
 *
 * - DE-DUPLICATION is not optional: one creation is several `rename`s (the entry, the size, the close — by platform),
 *   and a flow that MOVES the file would run again on a path that no longer exists. One path is accepted once per
 *   `dedupeMs`; while it is settling every further event for it belongs to the same creation.
 * - The SIZE is read once the file stops growing: `rename` fires the instant the path appears, at zero bytes, so a
 *   flow filtering on "over 5 MB" would never fire for the files the owner's example is about. Stat, wait, stat again
 *   until two readings agree or `maxSettleChecks` run out (a slow download: the size so far).
 * - A path that VANISHES while settling was a temp file or a delete: nothing was added, and the key is RELEASED so the
 *   re-creation that follows is seen.
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

export interface FileSourceDeps {
    readonly subscribe: (listener: (event: RawWatchEvent) => void) => () => void;
    /** `null` when the path is gone or unreadable. Never throws. */
    readonly statFile: (absPath: string) => { isFile: boolean; size: number } | null;
    readonly emit: (event: FileAddedProps) => void | Promise<void>;
    readonly dedupeMs?: number;
    readonly settleMs?: number;
    readonly maxSettleChecks?: number;
    readonly wait?: (ms: number) => Promise<void>;
    readonly now?: () => number;
}

export interface FileSource {
    /** A file a flow is about to move to this absolute path: its arrival is not a new addition (once). */
    expectArrival(absPath: string): void;
    stop(): void;
}

const DEFAULT_DEDUPE_MS = 500;
const DEFAULT_SETTLE_MS = 250;
/** A cap, not a target: a file still growing after this many readings is reported with the size so far. */
const DEFAULT_MAX_SETTLE_CHECKS = 20;
/** How long an expected arrival is waited for; one that never comes does not mute its path for ever. */
const ARRIVAL_WINDOW_MS = 30_000;

export function startFileSource(deps: FileSourceDeps): FileSource {
    const dedupeMs = deps.dedupeMs ?? DEFAULT_DEDUPE_MS;
    const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
    const maxSettleChecks = deps.maxSettleChecks ?? DEFAULT_MAX_SETTLE_CHECKS;
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = deps.now ?? Date.now;

    /** Path → when it was last accepted, or `null` while it is settling. */
    const lastSeen = new Map<string, number | null>();
    /** Absolute path → until when its arrival is the flow's own move. */
    const arriving = new Map<string, number>();
    let stopped = false;

    async function observe(raw: RawWatchEvent, key: string): Promise<void> {
        const absPath = join(raw.workspacePath, raw.relPath);
        let stat = deps.statFile(absPath);
        for (let i = 0; stat && i < maxSettleChecks; i++) {
            await wait(settleMs);
            if (stopped) return;
            const next = deps.statFile(absPath);
            if (!next) {
                stat = null;
                break;
            }
            const stable = next.size === stat.size;
            stat = next;
            if (stable) break;
        }
        const event = fileAddedEvent({ workspaceId: raw.workspaceId, workspacePath: raw.workspacePath, relPath: raw.relPath, eventType: raw.eventType, stat });
        if (!event) {
            // Not an addition after all. RELEASE the key: a delete must not suppress the re-creation that follows it.
            lastSeen.delete(key);
            return;
        }
        const at = now();
        lastSeen.set(key, at);
        prune(at);
        const expected = arriving.get(event.path);
        if (expected !== undefined) {
            arriving.delete(event.path);
            if (at <= expected) return;
        }
        try {
            await deps.emit(event);
        } catch (error) {
            // The emitter starts flows and has no caller to return to: reported, never an unhandled rejection.
            console.error(`[flows] file trigger: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    function prune(at: number): void {
        if (lastSeen.size >= 1000) {
            for (const [key, when] of lastSeen) if (when !== null && at - when >= dedupeMs) lastSeen.delete(key);
        }
        for (const [path, until] of arriving) if (at > until) arriving.delete(path);
    }

    const unsubscribe = deps.subscribe((raw) => {
        if (stopped || ignoredPath(raw.relPath)) return;
        // NUL-separated: the one byte a path cannot contain, so two (root, relPath) pairs never collide into one key.
        const key = `${raw.workspacePath}\u0000${raw.relPath}`;
        if (lastSeen.has(key)) {
            const previous = lastSeen.get(key);
            if (previous === null) return;
            if (previous !== undefined && now() - previous < dedupeMs) return;
        }
        lastSeen.set(key, null);
        void observe(raw, key);
    });

    return {
        expectArrival(absPath) {
            arriving.set(absPath, now() + ARRIVAL_WINDOW_MS);
        },
        stop() {
            stopped = true;
            unsubscribe();
            lastSeen.clear();
            arriving.clear();
        },
    };
}
