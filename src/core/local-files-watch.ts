import type { FilesViewEvent } from '../renderer/bridge.js';

/** These are connection controls: no view id can name another connection's interest. */
export const FILES_WATCH_METHODS = ['files.watch', 'files.unwatch', 'files.watchState'] as const;
export type FilesWatchMethod = typeof FILES_WATCH_METHODS[number];
export const FILES_EVENT_BYTES = 512 * 1024;
/** Independent revisions preserve a changed batch while a git result/refetch is in flight. */
export interface FilesWatchState {
    readonly revision: number;
    readonly pathsRevision: number;
    readonly gitRevision: number;
    readonly event: FilesViewEvent;
}
export type FilesWatchPush = { workspaceId: string; revision: number } & ({ state: FilesWatchState } | { changed: 'refetch' });
