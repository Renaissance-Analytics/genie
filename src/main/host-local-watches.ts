import type { TynnWatchKind, TynnWatchPort } from '../core/local-tynn-watch.js';
import type { FilesHubEvent, FilesWant, FilesWatchHub } from './files-watch-hub.js';
import type { TynnBoardHub, TynnBoardHubEvent } from './issue-watch-host.js';
import type { FilesWatchPort } from './local-files-watches.js';

/** RED STUB (Tynn #898 step 2d-3b): the shapes only; every function says it is not built. */
const NOT_BUILT = '2d-3b: not built';

export const HOST_LOCAL_OWNER = 'genie-host';

export function ownerRoute<E>(_local: (event: E) => void, _remote: (owner: string, event: E) => void): (owner: string, event: E) => void {
    throw new Error(NOT_BUILT);
}

export interface HostFilesWatchSources {
    readonly hub: () => Pick<FilesWatchHub, 'subscribe' | 'unsubscribe'> | null;
    readonly workspace: (id: string) => { readonly id: string; readonly path: string; readonly asleep?: boolean } | null;
    readonly recordDiskChanges: (workspaceId: string, changes: ReadonlyArray<{ readonly path: string; readonly at: number }>) => void;
    readonly log?: (line: string) => void;
}

export function hostFilesWatch(_sources: HostFilesWatchSources): { readonly port: FilesWatchPort; deliver(event: FilesHubEvent): void } {
    throw new Error(NOT_BUILT);
}

export interface HostTynnWatchSources {
    readonly hubs: Readonly<Record<TynnWatchKind, Pick<TynnBoardHub, 'watch' | 'unwatch'>>>;
}

export function hostTynnWatch(_sources: HostTynnWatchSources): { readonly port: TynnWatchPort; deliver(kind: TynnWatchKind, event: TynnBoardHubEvent): void } {
    throw new Error(NOT_BUILT);
}

export type { FilesWant };
