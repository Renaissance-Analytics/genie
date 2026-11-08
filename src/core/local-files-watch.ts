/** Native Files subscription shapes shared by the host and renderer without a UI import. */
export interface FilesViewWant { readonly git?: boolean; readonly repos?: readonly string[] }
export interface FilesViewEvent {
    readonly paths?: readonly string[];
    readonly git?: {
        readonly tree?: Readonly<Record<string, 'modified' | 'added' | 'deleted' | 'untracked'>>;
        readonly repos?: Readonly<Record<string, { ok: true; value: unknown } | { ok: false; error: string }>>;
    };
}

/** These are connection controls: no view id can name another connection's interest. */
export const FILES_WATCH_METHODS = ['files.watch', 'files.unwatch', 'files.watchState'] as const;
export type FilesWatchMethod = typeof FILES_WATCH_METHODS[number];
export const FILES_EVENT_BYTES = 512 * 1024;
type TreeState = 'modified' | 'added' | 'deleted' | 'untracked';
/**
 * WHAT CHANGED IN THE GIT TREE (Tynn #523): against the tree of git revision `base`, the entries set (added or changed)
 * and the paths removed. A push carries this instead of the whole tree once the window was sent one.
 */
export interface FilesTreeChanges { readonly base: number; readonly set: Readonly<Record<string, TreeState>>; readonly removed: readonly string[] }
/** What crosses to the window: a view's event, with the tree as its changes when the window holds the one before. */
export interface FilesWireEvent {
    readonly paths?: readonly string[];
    readonly git?: { readonly tree?: Readonly<Record<string, TreeState>>; readonly treeChanges?: FilesTreeChanges; readonly repos?: NonNullable<FilesViewEvent['git']>['repos'] };
}
/** Independent revisions preserve a changed batch while a git result/refetch is in flight. */
export interface FilesWatchState {
    readonly revision: number;
    readonly pathsRevision: number;
    readonly gitRevision: number;
    readonly event: FilesWireEvent;
}

/** The changes that turn tree `prev` into tree `next`. */
export function treeChangesOf(prev: Readonly<Record<string, TreeState>>, next: Readonly<Record<string, TreeState>>): { set: Record<string, TreeState>; removed: string[] } {
    const set: Record<string, TreeState> = {}, removed: string[] = [];
    for (const [path, state] of Object.entries(next)) if (prev[path] !== state) set[path] = state;
    for (const path of Object.keys(prev)) if (!Object.hasOwn(next, path)) removed.push(path);
    return { set, removed };
}

/** Tree `prev` with `changes` applied: a new object, `prev` untouched. */
export function applyTreeChanges(prev: Readonly<Record<string, TreeState>>, changes: Pick<FilesTreeChanges, 'set' | 'removed'>): Record<string, TreeState> {
    const next: Record<string, TreeState> = { ...prev };
    for (const path of changes.removed) delete next[path];
    for (const [path, state] of Object.entries(changes.set)) next[path] = state;
    return next;
}
export type FilesWatchPush = { workspaceId: string; revision: number } & ({ state: FilesWatchState } | { changed: 'refetch' });
