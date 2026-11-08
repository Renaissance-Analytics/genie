import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { confine, countsAsDiskChange } from '../core/files-panel.js';
import type { GitTreeState } from './git-ports.js';
import type { RepoResult } from './repo-git.js';
import type { RepoStatus } from './repo-model.js';
import { IGNORED_NAMES } from './files-host.js';
import { treeChangesOf } from '../core/local-files-watch.js';

/**
 * THE FILE WATCHER AND GIT, BEHIND PER-VIEW SUBSCRIPTIONS (the host split, P2.2: plan §11b).
 *
 * A view (the Files panel, the Repository panel, the ArtBoard, an Agent view) subscribes to a workspace's disk changes
 * for as long as it is shown, and says whether it wants git: the tree's colours (`git`) or a repo's status (`repos`).
 * The hub keeps ONE recursive watcher per workspace for as long as any view wants it — reference-counted, closed with the
 * last view — coalesces what it sees into one batch per `WATCH_BATCH_MS`, sends it to each CONNECTION (a window) whose
 * views watch that workspace, and runs git ONCE per batch however many views want it, never two runs at a time: a batch
 * that lands while git runs marks it, and it runs once more after.
 *
 * It runs in genie-host (session-engine-server's `files` option), so the watcher's events, the `stat` behind each and git
 * and its parsing cost the window nothing; in the window only on the emergency path, when no host can start.
 */

/** The window changes are coalesced over before the views are told (Genie 1's DEBOUNCE_MS). */
export const WATCH_BATCH_MS = 250;

/** What a view wants beside the batch itself. */
export interface FilesWant {
    /** The tree's git colours (`gitTreeStatus` of the workspace root). */
    readonly git?: boolean;
    /** These repos' status (`repoStatus`, by their path relative to the workspace; `''` = the root). */
    readonly repos?: readonly string[];
}

export type FilesHubEvent =
    | { readonly kind: 'changed'; readonly workspaceId: string; readonly changes: ReadonlyArray<{ readonly path: string; readonly at: number }> }
    | {
        readonly kind: 'git';
        readonly workspaceId: string;
        readonly tree?: Readonly<Record<string, GitTreeState>>;
        /**
         * Instead of `tree` (Tynn #524): what changed since the tree this connection was last sent. A connection is sent
         * the whole tree first, and again whenever it is new to the workspace; then only this.
         */
        readonly treeChanges?: { readonly set: Readonly<Record<string, GitTreeState>>; readonly removed: readonly string[] };
        /** In the window only (files-tree-keeper.ts): the tree before this one, and what changed, for its views' pushes. */
        readonly changes?: { readonly prev: Readonly<Record<string, GitTreeState>>; readonly set: Readonly<Record<string, GitTreeState>>; readonly removed: readonly string[] };
        readonly repos?: Readonly<Record<string, RepoResult<RepoStatus>>>;
    };

/** A recursive watcher of `root` that reports each changed FILE as a confined, forward-slashed relative path. */
export type WatchSource = (root: string, onPath: (rel: string) => void) => { close(): void };

export interface FilesWatchHubOptions {
    /** Late-bound metadata only: a hibernated workspace has no watcher or git reads. */
    readonly workspaceVisible?: (workspaceId: string) => boolean;
    /** Where a batch or a git result goes: the connection (a window) that owns the views. */
    readonly send: (owner: string, event: FilesHubEvent) => void;
    /** The watcher; absent = `nodeWatchSource`. Injected so a test drives the events. */
    readonly source?: WatchSource;
    readonly gitTree?: (root: string) => Promise<Record<string, GitTreeState>>;
    readonly repoStatus?: (root: string, repoRel: string) => Promise<RepoResult<RepoStatus>>;
    /** Genie's clock, for when a change was seen. */
    readonly now?: () => number;
    /** The batch timer; absent = setTimeout over WATCH_BATCH_MS. Returns its cancel. */
    readonly schedule?: (fn: () => void, ms: number) => () => void;
    readonly log?: (line: string) => void;
}

interface View { readonly owner: string; readonly viewId: string; readonly workspaceId: string; readonly workspacePath: string; readonly want: FilesWant }

interface Watched {
    readonly root: string;
    readonly handle: { close(): void };
    pending: Map<string, number> | null;
    cancel: (() => void) | null;
    gitRunning: boolean;
    gitDirty: boolean;
    /** The tree last sent, and the connections that hold it (Tynn #524): those are sent only its changes. */
    tree: Readonly<Record<string, GitTreeState>> | null;
    holders: Set<string>;
}

const viewKey = (owner: string, viewId: string) => `${owner}\u0000${viewId}`;

export class FilesWatchHub {
    readonly #options: FilesWatchHubOptions;
    readonly #views = new Map<string, View>();
    readonly #watched = new Map<string, Watched>();

    constructor(options: FilesWatchHubOptions) {
        this.#options = options;
    }

    /** A view wants this workspace's changes (again: the same owner and view id replaces what it wanted). */
    subscribe(owner: string, viewId: string, workspace: { id: string; path: string }, want: FilesWant): void {
        this.#views.set(viewKey(owner, viewId), { owner, viewId, workspaceId: workspace.id, workspacePath: workspace.path, want: { ...(want.git ? { git: true } : {}), ...(want.repos && want.repos.length > 0 ? { repos: [...want.repos] } : {}) } });
        this.#ensureWatch(workspace);
    }

    #ensureWatch(workspace: { id: string; path: string }): void {
        if (this.#options.workspaceVisible?.(workspace.id) === false) return;
        if (this.#watched.has(workspace.id)) return;
        const source = this.#options.source ?? nodeWatchSource;
        const handle = source(workspace.path, (rel) => this.#seen(workspace.id, rel));
        this.#watched.set(workspace.id, { root: workspace.path, handle, pending: null, cancel: null, gitRunning: false, gitDirty: false, tree: null, holders: new Set() });
    }

    /** Keep view intentions as metadata; close all IO while hidden and reopen live views on redock. */
    visibilityChanged(): void {
        for (const [id, watched] of [...this.#watched]) {
            if (this.#options.workspaceVisible?.(id) !== false) continue;
            this.#watched.delete(id); watched.cancel?.(); watched.handle.close();
        }
        for (const view of this.#views.values()) this.#ensureWatch({ id: view.workspaceId, path: view.workspacePath });
    }

    /** The view let go; the workspace's watcher closes with its last view. */
    unsubscribe(owner: string, viewId: string): void {
        const view = this.#views.get(viewKey(owner, viewId));
        if (!view) return;
        this.#views.delete(viewKey(owner, viewId));
        this.#release(view.workspaceId);
    }

    /** A connection went (a window closed or crashed): every view it had lets go. */
    dropOwner(owner: string): void {
        const released = new Set<string>();
        for (const [key, view] of [...this.#views]) {
            if (view.owner !== owner) continue;
            this.#views.delete(key);
            released.add(view.workspaceId);
        }
        for (const id of released) this.#release(id);
    }

    /** The workspaces with a watcher now. */
    watching(): string[] {
        return [...this.#watched.keys()];
    }

    close(): void {
        for (const w of this.#watched.values()) { w.cancel?.(); w.handle.close(); }
        this.#watched.clear();
        this.#views.clear();
    }

    #release(workspaceId: string): void {
        // A connection with no view of this workspace left no longer holds its tree: if it comes back, it is sent it whole.
        const held = this.#watched.get(workspaceId);
        if (held) for (const owner of [...held.holders]) if (![...this.#views.values()].some((v) => v.workspaceId === workspaceId && v.owner === owner)) held.holders.delete(owner);
        if ([...this.#views.values()].some((v) => v.workspaceId === workspaceId)) return;
        const w = this.#watched.get(workspaceId);
        if (!w) return;
        this.#watched.delete(workspaceId);
        w.cancel?.();
        w.handle.close();
    }

    #seen(workspaceId: string, rel: string): void {
        if (this.#options.workspaceVisible?.(workspaceId) === false) return;
        const w = this.#watched.get(workspaceId);
        if (!w) return;
        const at = (this.#options.now ?? Date.now)();
        if (w.pending) { w.pending.set(rel, at); return; }
        w.pending = new Map([[rel, at]]);
        // A FIXED window, not a sliding one: steady churn still reaches the views every WATCH_BATCH_MS — live, and bounded.
        const schedule = this.#options.schedule ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
        w.cancel = schedule(() => this.#flush(workspaceId), WATCH_BATCH_MS);
    }

    #flush(workspaceId: string): void {
        if (this.#options.workspaceVisible?.(workspaceId) === false) return;
        const w = this.#watched.get(workspaceId);
        if (!w || !w.pending) return;
        const changes = [...w.pending].map(([path, at]) => ({ path, at }));
        w.pending = null;
        w.cancel = null;
        const event: FilesHubEvent = { kind: 'changed', workspaceId, changes };
        for (const owner of this.#ownersOf(workspaceId, () => true)) this.#options.send(owner, event);
        void this.#git(workspaceId);
    }

    #ownersOf(workspaceId: string, wants: (v: View) => boolean): string[] {
        return [...new Set([...this.#views.values()].filter((v) => v.workspaceId === workspaceId && wants(v)).map((v) => v.owner))];
    }

    async #git(workspaceId: string): Promise<void> {
        if (this.#options.workspaceVisible?.(workspaceId) === false) return;
        const w = this.#watched.get(workspaceId);
        if (!w) return;
        const views = [...this.#views.values()].filter((v) => v.workspaceId === workspaceId);
        const tree = views.some((v) => v.want.git) && this.#options.gitTree !== undefined;
        const repos = [...new Set(views.flatMap((v) => v.want.repos ?? []))].filter(() => this.#options.repoStatus !== undefined);
        if (!tree && repos.length === 0) return;
        // NEVER TWO RUNS AT A TIME: a batch that lands while git runs is answered by one more run after it.
        if (w.gitRunning) { w.gitDirty = true; return; }
        w.gitRunning = true;
        try {
            const [treeState, repoStates] = await Promise.all([
                tree ? this.#options.gitTree!(w.root).catch(() => null) : Promise.resolve(null),
                Promise.all(repos.map(async (rel) => [rel, await this.#options.repoStatus!(w.root, rel).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))] as const)),
            ]);
            if (this.#watched.get(workspaceId) !== w) return; // nobody watches it any more
            const repoPart = repoStates.length > 0 ? { repos: Object.fromEntries(repoStates) } : {};
            const owners = this.#ownersOf(workspaceId, (v) => v.want.git === true || (v.want.repos?.length ?? 0) > 0);
            /*
             * ONLY WHAT CHANGED (Tynn #524): a connection that holds the last tree is sent what changed since it; one that
             * does not (new to the workspace) the whole tree. Whole for everyone when the changes are more than the tree.
             */
            const changes = treeState && w.tree ? treeChangesOf(w.tree, treeState) : null;
            const small = changes !== null && Object.keys(changes.set).length + changes.removed.length <= Object.keys(treeState!).length;
            for (const owner of owners) {
                const treePart = !treeState ? {} : small && w.holders.has(owner) ? { treeChanges: changes! } : { tree: treeState };
                this.#options.send(owner, { kind: 'git', workspaceId, ...treePart, ...repoPart });
            }
            if (treeState) { w.tree = treeState; w.holders = new Set(owners); }
        } finally {
            w.gitRunning = false;
            if (w.gitDirty && this.#watched.get(workspaceId) === w) {
                w.gitDirty = false;
                void this.#git(workspaceId);
            }
        }
    }
}

/**
 * The real watcher: `fs.watch` recursive, each event confined to the root, ignored folders (`.git`, `node_modules`, build
 * output) left out, and only FILES counted (Windows reports a written file's parent folders too; a path that no longer
 * exists is a deletion and still counts — `countsAsDiskChange`).
 */
export const nodeWatchSource: WatchSource = (root, onPath) => {
    // Only what changes AFTER this moment is a change — on macOS, where FSEvents replays writes made just before the
    // watcher attached (the v2.0.0-beta.5 release run saw a set-up write come back as "unreported"). Nowhere else: Linux
    // stamps file times from a coarse clock that lags Date.now(), so a write made just after the start can carry an
    // earlier time and was dropped (the WSL suite timed out on it 2 runs in 5). inotify and Windows do not replay.
    const since = process.platform === 'darwin' ? Date.now() : Number.NEGATIVE_INFINITY;
    let closed = false;
    const watcher = watch(root, { recursive: true }, (_type, filename) => {
        if (typeof filename !== 'string') return;
        const rel = confine(root, filename);
        if (rel === null || rel === '' || rel.split('/').some((seg) => IGNORED_NAMES.has(seg))) return;
        void stat(join(root, ...rel.split('/'))).then(
            (info) => { if (!closed && countsAsDiskChange({ mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() }, since)) onPath(rel); },
            () => { if (!closed && countsAsDiskChange(null, since)) onPath(rel); },
        );
    });
    watcher.on('error', () => { /* a lost watcher means no new marks; the tree still opens */ });
    return { close: () => { closed = true; watcher.close(); } };
};
