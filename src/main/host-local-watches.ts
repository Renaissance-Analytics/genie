import type { TynnWatchEvent, TynnWatchKind, TynnWatchPort } from '../core/local-tynn-watch.js';
import { FilesTreeKeeper } from './files-tree-keeper.js';
import type { FilesHubEvent, FilesWatchHub } from './files-watch-hub.js';
import type { TynnBoardHub, TynnBoardHubEvent } from './issue-watch-host.js';
import type { FilesWatchPort } from './local-files-watches.js';

/**
 * GENIE-HOST'S OWN WATCHES (Tynn #898 step 2d-3b). The files hub and the three Tynn hubs send each event to the owner of
 * the view. genie-host's own answers (host-alone-api.ts) own every view, under one owner id, so its RemoteHost serves
 * `files.watch` and `tynn.watch` from its own hubs: the window's file panel and live Tynn tab are watched this way. An
 * engine-link connection (a window's main) owned views too, until nothing in a window read them: the Files watch left in
 * Tynn #1043, the Tynn watches in #934 task #1474. No hub sends an event over the engine link.
 *
 * The id is not a UUID, so it can never be an engine-link connection's (session-engine-server.ts gives those randomUUID()).
 */
export const HOST_LOCAL_OWNER = 'genie-host';

export interface HostFilesWatchSources {
    /** genie-host's files hub; null until it is built (after the engine server). */
    readonly hub: () => Pick<FilesWatchHub, 'subscribe' | 'unsubscribe'> | null;
    /** A workspace on genie-host's roster, with its folder; null = no such workspace. */
    readonly workspace: (id: string) => { readonly id: string; readonly path: string; readonly asleep?: boolean } | null;
    /** The file panel's record of what changed on disk (FilesHost), as main's was fed from the same events. */
    readonly recordDiskChanges: (workspaceId: string, changes: ReadonlyArray<{ readonly path: string; readonly at: number }>) => void;
    readonly log?: (line: string) => void;
}

/**
 * THE FILES WATCH PORT, OVER GENIE-HOST'S HUB. The hub sends a connection the whole git tree once, then only what changed
 * (Tynn #524); the views (local-files-watches.ts) expect whole trees, so they are kept here as main keeps them.
 */
export function hostFilesWatch(sources: HostFilesWatchSources): { readonly port: FilesWatchPort; deliver(event: FilesHubEvent): void } {
    const keeper = new FilesTreeKeeper(sources.log);
    const listeners = new Set<(event: FilesHubEvent) => void>();
    const awake = (id: string) => { const w = sources.workspace(id); return w && w.asleep !== true ? w : null; };
    const port: FilesWatchPort = {
        exists: (id) => awake(id) !== null,
        watch: (viewId, id, want) => {
            const workspace = awake(id), hub = sources.hub();
            if (!workspace || !hub) return false;
            hub.subscribe(HOST_LOCAL_OWNER, viewId, { id: workspace.id, path: workspace.path }, want);
            return true;
        },
        unwatch: (viewId) => { sources.hub()?.unsubscribe(HOST_LOCAL_OWNER, viewId); },
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const deliver = (received: FilesHubEvent): void => {
        const event = keeper.accept(received);
        if (event.kind === 'changed') sources.recordDiskChanges(event.workspaceId, event.changes);
        for (const listener of [...listeners]) listener(event);
    };
    return { port, deliver };
}

export interface HostTynnWatchSources {
    /** genie-host's Tynn hubs, one per kind: each says false for a workspace not linked to a Tynn project. */
    readonly hubs: Readonly<Record<TynnWatchKind, Pick<TynnBoardHub, 'watch' | 'unwatch'>>>;
}

/** THE TYNN WATCH PORT, OVER GENIE-HOST'S THREE HUBS: one view per watch; its signals, by kind and workspace. */
export function hostTynnWatch(sources: HostTynnWatchSources): { readonly port: TynnWatchPort; deliver(kind: TynnWatchKind, event: TynnBoardHubEvent): void } {
    const listeners = new Set<(event: TynnWatchEvent) => void>();
    const port: TynnWatchPort = {
        watch: async (kind, viewId, workspaceId) => sources.hubs[kind].watch(HOST_LOCAL_OWNER, viewId, workspaceId),
        unwatch: (kind, viewId) => { sources.hubs[kind].unwatch(HOST_LOCAL_OWNER, viewId); },
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const deliver = (kind: TynnWatchKind, event: TynnBoardHubEvent): void => {
        for (const listener of [...listeners]) listener({ kind, workspaceId: event.workspaceId, signal: event.signal });
    };
    return { port, deliver };
}
