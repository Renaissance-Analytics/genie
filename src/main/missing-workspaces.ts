import { stat } from 'node:fs/promises';

/**
 * A WORKSPACE WHOSE FOLDER IS GONE IS MISSING, NEVER DROPPED (host split P7, build spec item 3; ruling R1, 2026-11-23).
 *
 * The registry records where each workspace's folder was. A rebuilt machine, a moved folder or an unmounted drive leaves
 * a record whose folder is not there. That is a fact of THIS machine NOW, not a stored field: it is looked up here, kept
 * in memory, and nothing is written anywhere by the look (this module has no write port at all). The workspace stays in
 * the registry and in every list; its Dashboard row says the folder is not found and offers "Locate folder", and its
 * agents are not started (workspace-ops-host.ts `startRefusal`).
 *
 * A folder that comes back by itself (the drive is mounted again) clears the flag with no action: the look is repeated on
 * a timer, every {@link MISSING_RECHECK_MS} while any workspace is missing and every {@link PRESENT_RECHECK_MS} otherwise.
 *
 * A hibernated workspace is not looked at and never flagged: its folder is never read (registry.ts).
 *
 * "We could not look" is not "it is gone": a look that fails for any reason but "nothing is there" (no permission, a
 * disk error, a drive that does not answer) changes nothing: what was known of that workspace stands.
 */

/** How often the folders are looked at again while at least one is missing. */
export const MISSING_RECHECK_MS = 10_000;
/** How often they are looked at again while every folder is there. */
export const PRESENT_RECHECK_MS = 60_000;
/** How long one look may take before it counts as "could not look" (a network drive that does not answer). */
export const LOOK_TIMEOUT_MS = 5_000;

export interface MissingWorkspacesPorts {
    /** Every registered workspace, hibernated ones included (they are skipped here, by their flag). */
    workspaces(): readonly { readonly id: string; readonly path: string; readonly asleep?: boolean | undefined }[];
    /**
     * `true`: a directory is at the path. `false`: nothing is there, or what is there is not a directory. A rejection:
     * the look itself failed, which says nothing about the folder.
     */
    isDirectory(path: string): Promise<boolean>;
    /** Runs `fn` once after `ms`; the answer cancels it. Injected so a test drives time. */
    schedule(ms: number, fn: () => void): () => void;
    log?(line: string): void;
}

export class MissingWorkspaces {
    readonly #ports: MissingWorkspacesPorts;
    /** Workspace id → the recorded path that is not there. */
    #missing: ReadonlyMap<string, string> = new Map();
    readonly #listeners = new Set<() => void>();
    #chain: Promise<void> = Promise.resolve();
    /** A pass is asked for and has not begun: it will read the registry when it does, so a second ask adds nothing. */
    #queued = false;
    #started = false;
    #cancel: (() => void) | null = null;

    constructor(ports: MissingWorkspacesPorts) {
        this.#ports = ports;
    }

    /** Whether this workspace's folder was not there at the last look. */
    isMissing(workspaceId: string): boolean {
        return this.#missing.has(workspaceId);
    }

    /** The recorded path that is not there, or `null` when the folder is there (or was never looked at). */
    pathIfMissing(workspaceId: string): string | null {
        return this.#missing.get(workspaceId) ?? null;
    }

    /** Called once per change of the missing set (a folder gone, a folder back), never per look. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** Look now, and keep looking on the timer until {@link stop}. */
    start(): Promise<void> {
        this.#started = true;
        return this.check();
    }

    stop(): void {
        this.#started = false;
        this.#cancel?.();
        this.#cancel = null;
    }

    /**
     * Look at every folder. One pass at a time: an ask during a pass is answered by ONE further pass, which reads the
     * registry afresh, so a caller that has just changed a record always gets a look made after its change.
     */
    check(): Promise<void> {
        if (this.#queued) return this.#chain;
        this.#queued = true;
        this.#chain = this.#chain.then(() => {
            this.#queued = false;
            return this.#pass();
        });
        return this.#chain;
    }

    async #pass(): Promise<void> {
        const before = this.#missing;
        const next = new Map<string, string>();
        try {
            const awake = this.#ports.workspaces().filter((w) => w.asleep !== true);
            const looks = await Promise.all(awake.map(async (w): Promise<boolean | null> => {
                try {
                    return await this.#ports.isDirectory(w.path);
                } catch (error) {
                    this.#ports.log?.(`missing-workspaces: could not look at ${w.path}: ${error instanceof Error ? error.message : String(error)}`);
                    return null;
                }
            }));
            awake.forEach((w, i) => {
                const there = looks[i];
                // Could not look: what was known of this workspace AT THIS PATH stands.
                if (there === null || there === undefined) { if (before.get(w.id) === w.path) next.set(w.id, w.path); return; }
                if (!there) next.set(w.id, w.path);
            });
        } catch (error) {
            // The registry could not be read: nothing new is known, so nothing changes.
            this.#ports.log?.(`missing-workspaces: the pass failed: ${error instanceof Error ? error.message : String(error)}`);
            this.#arm();
            return;
        }
        const changed = next.size !== before.size || [...next].some(([id, path]) => before.get(id) !== path);
        this.#missing = next;
        this.#arm();
        if (!changed) return;
        this.#ports.log?.(`missing-workspaces: ${next.size === 0 ? 'every folder is there' : `not there: ${[...next.values()].join(', ')}`}`);
        for (const listener of [...this.#listeners]) {
            try { listener(); } catch { /* one listener's failure is not another's */ }
        }
    }

    #arm(): void {
        this.#cancel?.();
        this.#cancel = null;
        if (!this.#started) return;
        this.#cancel = this.#ports.schedule(this.#missing.size > 0 ? MISSING_RECHECK_MS : PRESENT_RECHECK_MS, () => {
            this.#cancel = null;
            void this.check();
        });
    }
}

/**
 * The real look: `true` for a directory; `false` when nothing is there (ENOENT, or ENOTDIR for a path through a file)
 * or when what is there is not a directory; a rejection for every other failure and for a look that does not answer
 * within {@link LOOK_TIMEOUT_MS}.
 */
export async function nodeIsDirectory(path: string): Promise<boolean> {
    let fail: (error: Error) => void = () => {};
    const late = new Promise<never>((_resolve, reject) => { fail = reject; });
    const timer = setTimeout(() => fail(new Error(`no answer within ${LOOK_TIMEOUT_MS} ms`)), LOOK_TIMEOUT_MS);
    timer.unref();
    try {
        return (await Promise.race([stat(path), late])).isDirectory();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/** genie-host's ports: the real disk and unref'd timers, so the look never keeps the process alive. */
export function nodeMissingWorkspaces(workspaces: MissingWorkspacesPorts['workspaces'], log?: (line: string) => void): MissingWorkspaces {
    return new MissingWorkspaces({
        workspaces,
        isDirectory: nodeIsDirectory,
        schedule: (ms, fn) => {
            const timer = setTimeout(fn, ms);
            timer.unref();
            return () => clearTimeout(timer);
        },
        ...(log ? { log } : {}),
    });
}
