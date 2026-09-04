/**
 * The first system trigger: a file appeared in a workspace.
 *
 * The owner's reference case, which this exists to make possible:
 *
 *   > a file added anywhere in a workspace, and if it is over 5 MB it gets moved
 *   > into an untracked folder so the repo does not get heavy
 *
 * An event (file added), a prop (size), a filter (> 5 MB), an action (move).
 * This module owns the first two.
 *
 * ## Definition and producer live together
 *
 * `FILE_ADDED_EVENT` declares the props a Flow may filter on, and the code below
 * is what actually emits them. Splitting those across files is how a registry
 * entry ends up promising a prop nothing sends — a Flow that looks armed and can
 * never fire, with nothing anywhere looking wrong. Keeping them adjacent makes
 * the drift visible, and a test asserts every declared prop appears on a real
 * event.
 *
 * ## How "added" is decided
 *
 * `fs.watch` reports `rename` when a path appears, vanishes or is renamed, and
 * `change` when existing content is written. So an addition is `rename` PLUS the
 * path now existing as a file — one stat, no bookkeeping, no baseline scan of
 * the tree at boot.
 *
 * The known imprecision, stated rather than hidden: an editor that saves by
 * writing a temp file and renaming it over the original produces `rename`, and
 * this reports it as an addition. That is defensible — the bytes at that path
 * ARE new — and the alternative (remembering every path in every workspace) buys
 * a nicer word for a large amount of memory.
 *
 * ## Why de-duplication is not optional
 *
 * A single file creation routinely produces several `rename` events (the entry,
 * then the size, then the close, depending on the platform). Without a window,
 * one new file runs the Flow three times, and for a Flow that MOVES the file the
 * second and third runs act on a path that no longer exists.
 *
 * ## Why the size is not read straight away
 *
 * `rename` fires the instant the path APPEARS — at zero bytes. A 6 MB file being
 * copied in is 0 bytes when Genie first hears about it, so a Flow filtering on
 * "over 5 MB" would never fire for exactly the files the owner's example is
 * about, and would look like a filter bug rather than a timing one.
 *
 * So the size is read once the file stops growing: stat, wait, stat again, until
 * two readings agree or the attempts run out. This is why `sizeBytes` means
 * anything at all.
 */

import path from 'node:path';
import type { FileWatchEvent } from '../files/watch';
import type { FlowEvent, FlowEventDefinition } from './types';

export const FILE_ADDED_EVENT: FlowEventDefinition = {
    id: 'files:added',
    label: 'A file was added to a workspace',
    purpose: 'Files',
    props: [
        { key: 'workspaceId', type: 'string', label: 'Workspace', description: 'The workspace it landed in.' },
        { key: 'workspacePath', type: 'string', label: 'Workspace root', description: 'Absolute path of the workspace root.' },
        { key: 'path', type: 'string', label: 'Path', description: 'Absolute path of the new file.' },
        { key: 'relPath', type: 'string', label: 'Path in workspace', description: 'Forward-slashed, relative to the workspace root.' },
        { key: 'name', type: 'string', label: 'File name', description: 'Including the extension.' },
        { key: 'extension', type: 'string', label: 'Extension', description: 'Lower-case, without the dot. Empty when there is none.' },
        { key: 'sizeBytes', type: 'number', label: 'Size in bytes', description: 'As reported when the file was noticed.' },
    ],
};

/** What the producer knows about a candidate addition. */
export interface FileAddedInput {
    workspaceId: string;
    workspacePath: string;
    /** Forward-slashed, workspace-relative. */
    relPath: string;
    eventType: 'rename' | 'change';
    /** The path as it is NOW. `null` when it does not exist. */
    stat: { isFile: boolean; size: number } | null;
}

/**
 * PURE. The event for this observation, or `null` when it was not an addition.
 *
 * Separated from the wiring so the three ways a watch event is NOT an addition
 * (a content change, a delete, a directory) are decided by a function with no
 * filesystem, no timers and no subscription behind it.
 */
export function buildFileAddedEvent(input: FileAddedInput): FlowEvent | null {
    if (input.eventType !== 'rename') return null;
    if (!input.stat || !input.stat.isFile) return null;

    const name = input.relPath.split('/').pop() ?? input.relPath;
    const dot = name.lastIndexOf('.');
    // A leading dot is not an extension: `.gitignore` has none.
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';

    return {
        event: FILE_ADDED_EVENT.id,
        props: {
            workspaceId: input.workspaceId,
            workspacePath: input.workspacePath,
            // Platform-native, built the same way the mover builds a destination
            // — an echo is matched by exact string, so both sides must agree on
            // separators.
            path: path.join(input.workspacePath, input.relPath),
            relPath: input.relPath,
            name,
            extension,
            sizeBytes: input.stat.size,
        },
        source: { kind: 'system' },
    };
}

export interface FlowFileSourceDeps {
    /** Usually `onFileWatchEvent`. Injected so this is testable without a watcher. */
    subscribe: (listener: (event: FileWatchEvent) => void) => () => void;
    /** `null` when the path is gone or unreadable. Never throws. */
    statFile: (absPath: string) => { isFile: boolean; size: number } | null;
    /** The workspace id for a watched root, or undefined if it is not one of ours. */
    workspaceIdFor: (workspacePath: string) => string | undefined;
    emit: (event: FlowEvent) => void | Promise<void>;
    /** How long one path stays de-duplicated. */
    dedupeMs?: number;
    /** How long to wait between size readings while a file is still growing. */
    settleMs?: number;
    /** How many readings to take before giving up and using the last one. */
    maxSettleChecks?: number;
    /** Injected so the settle loop is testable without real time passing. */
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
}

const DEFAULT_DEDUPE_MS = 500;
const DEFAULT_SETTLE_MS = 250;
/**
 * A cap, not a target. A file still growing after this many readings is being
 * written slowly (a large download); reporting the size we have is more useful
 * than waiting forever, and it is seen again if it is touched later.
 */
const DEFAULT_MAX_SETTLE_CHECKS = 20;

/** Begin turning watch events into `files:added`. Returns the stop function. */
export function startFlowFileSource(deps: FlowFileSourceDeps): () => void {
    const dedupeMs = deps.dedupeMs ?? DEFAULT_DEDUPE_MS;
    const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
    const maxSettleChecks = deps.maxSettleChecks ?? DEFAULT_MAX_SETTLE_CHECKS;
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = deps.now ?? Date.now;

    /** Path key → when it was last accepted, or `null` while it is settling. */
    const lastSeen = new Map<string, number | null>();
    let stopped = false;

    /** Read the size once the file stops growing, then emit if it was an addition. */
    async function observe(raw: FileWatchEvent, workspaceId: string, key: string): Promise<void> {
        const absPath = path.join(raw.workspacePath, raw.relPath);
        let stat = deps.statFile(absPath);

        for (let i = 0; stat && i < maxSettleChecks; i++) {
            await wait(settleMs);
            if (stopped) return;
            const next = deps.statFile(absPath);
            // Gone again — a temp file, or a delete that followed the create.
            // Nothing was added, so nothing is reported.
            if (!next) {
                stat = null;
                break;
            }
            const stable = next.size === stat.size;
            stat = next;
            if (stable) break;
        }

        const event = buildFileAddedEvent({
            workspaceId,
            workspacePath: raw.workspacePath,
            relPath: raw.relPath,
            eventType: raw.eventType,
            stat,
        });

        if (!event) {
            // Not an addition after all. RELEASE the key rather than marking it:
            // a delete must not suppress the re-creation that follows it.
            lastSeen.delete(key);
            return;
        }

        const at = now();
        lastSeen.set(key, at);
        pruneSeen(lastSeen, at, dedupeMs);

        try {
            await deps.emit(event);
        } catch (e) {
            // The emitter runs Flows and has no caller to return to. Reported
            // rather than left to become an unhandled rejection.
            console.error('[flows] file source emit failed', e);
        }
    }

    const unsubscribe = deps.subscribe((raw) => {
        if (stopped) return;
        const workspaceId = deps.workspaceIdFor(raw.workspacePath);
        if (!workspaceId) return;

        // NUL-separated: it is the one byte a path cannot contain, so two
        // different (root, relPath) pairs can never collide into one key.

        const key = `${raw.workspacePath}\u0000${raw.relPath}`;
        if (lastSeen.has(key)) {
            const previous = lastSeen.get(key);
            // `null` means a settle loop is already running for this path, so
            // every further event for it belongs to the same file creation.
            if (previous === null) return;
            if (previous !== undefined && now() - previous < dedupeMs) return;
        }
        lastSeen.set(key, null);

        void observe(raw, workspaceId, key);
    });

    return () => {
        stopped = true;
        unsubscribe();
        lastSeen.clear();
    };
}

/** Keep the de-duplication table bounded — a build can touch thousands of paths. */
function pruneSeen(seen: Map<string, number | null>, at: number, dedupeMs: number): void {
    if (seen.size < 1000) return;
    for (const [key, when] of seen) {
        if (when !== null && at - when >= dedupeMs) seen.delete(key);
    }
}
