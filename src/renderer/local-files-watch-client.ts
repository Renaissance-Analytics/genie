import { applyTreeChanges, type FilesWatchMethod, type FilesWatchPush, type FilesWatchState } from '../core/local-files-watch.js';
import type { FilesViewEvent, FilesViewWant, GenieBridge } from './bridge.js';
import { unlimited, type HeldLimit } from './local-content-client.js';

interface View { id: string; listener: (event: FilesViewEvent) => void }
/** `tree`: the git tree of revision `git` as this window holds it (Tynn #523: pushes carry only its changes). */
interface Group { views: Set<View>; revision: number; paths: number; git: number; wanted: number; fetching: boolean; tree: NonNullable<FilesViewEvent['git']>['tree'] | null }
/** One client and one refetch per workspace, however many visible views need the batch. */
export function localFilesWatchClient(port: {
    read<T>(method: FilesWatchMethod, ...args: unknown[]): Promise<T>;
    decode<T>(result: unknown): Promise<T>;
    on(listener: (push: unknown) => void): () => void;
    refusal(reason: string): void;
    limit?: HeldLimit;
}) {
    const limit = port.limit ?? unlimited;
    const groups = new Map<string, Group>(), changes = new Set<(id: string, paths?: readonly string[]) => void>();
    let sequence = 0, closed = false;
    const active = (id: string, group: Group) => !closed && groups.get(id) === group && group.views.size > 0;
    const failed = (error: unknown) => { if (!closed) port.refusal(error instanceof Error ? error.message : String(error)); };
    const deliver = (id: string, group: Group, state: FilesWatchState) => {
        if (!active(id, group) || !state || !Number.isSafeInteger(state.revision) || state.revision < group.revision || !Number.isSafeInteger(state.pathsRevision) || !Number.isSafeInteger(state.gitRevision) || !state.event) return;
        const event: { paths?: readonly string[]; git?: NonNullable<FilesViewEvent['git']> } = {};
        const git = state.gitRevision > group.git ? state.event.git : undefined;
        // Changes to a tree this window does not hold are never applied: the whole state is read instead.
        if (git?.treeChanges && (!group.tree || git.treeChanges.base !== group.git)) { group.wanted = Math.max(group.wanted, state.revision); void refetch(id, group); return; }
        if (state.pathsRevision > group.paths && state.event.paths) { event.paths = state.event.paths; group.paths = state.pathsRevision; }
        if (git) {
            const tree = git.treeChanges ? applyTreeChanges(group.tree!, git.treeChanges) : git.tree;
            event.git = { ...(tree ? { tree } : {}), ...(git.repos ? { repos: git.repos } : {}) };
            group.git = state.gitRevision; group.tree = tree ?? null;
        }
        group.revision = state.revision;
        if (event.paths) for (const listener of changes) listener(id, event.paths);
        if (event.paths || event.git) for (const view of group.views) view.listener(event);
    };
    const refetch = async (id: string, group: Group) => {
        if (group.fetching) return; group.fetching = true;
        try {
            while (active(id, group) && group.wanted > group.revision) {
                const requested = group.wanted;
                const view = group.views.values().next().value!;
                const state = await limit(async () => port.decode<FilesWatchState | null>(await port.read('files.watchState', view.id)));
                if (!active(id, group)) return;
                if (state && state.revision <= group.revision) continue;
                if (!state || state.revision < requested) {
                    // No retry of an older answer. A subsequent push may request the next cached state.
                    throw new Error('the Files watch state did not include the requested batch');
                }
                if (state.revision < group.wanted) continue;
                deliver(id, group, state);
            }
        } catch (error) { if (active(id, group)) failed(error); }
        finally { group.fetching = false; }
    };
    const off = port.on(raw => {
        if (closed || !raw || typeof raw !== 'object') return;
        const push = raw as FilesWatchPush, group = groups.get(push.workspaceId);
        if (!group || !Number.isSafeInteger(push.revision) || push.revision <= group.revision) return;
        if ('state' in push) deliver(push.workspaceId, group, push.state);
        else if (push.changed === 'refetch') { group.wanted = Math.max(group.wanted, push.revision); void refetch(push.workspaceId, group); }
    });
    const files: Pick<GenieBridge['files'], 'subscribe' | 'onChange'> = {
        subscribe: (workspaceId, rawWant, listener) => {
            if (closed) return () => {};
            if (typeof workspaceId !== 'string') { failed('A Files workspace id must be a string.'); return () => {}; }
            const w = (rawWant ?? {}) as FilesViewWant;
            const repos = Array.isArray(w.repos) ? w.repos.filter((r): r is string => typeof r === 'string') : [];
            const want: FilesViewWant = { ...(w.git === true ? { git: true } : {}), ...(repos.length ? { repos } : {}) };
            let group = groups.get(workspaceId);
            if (!group) { group = { views: new Set(), revision: 0, paths: 0, git: 0, wanted: 0, fetching: false, tree: null }; groups.set(workspaceId, group); }
            const view: View = { id: `files-${++sequence}`, listener }; group.views.add(view);
            let live = true;
            void port.read<boolean>('files.watch', view.id, workspaceId, want).then(ok => { if (live && !ok) failed('This Files view could not watch the workspace.'); }, error => { if (live) failed(error); });
            return () => {
                if (!live) return; live = false; group.views.delete(view);
                if (!group.views.size) groups.delete(workspaceId);
                if (!closed) void port.read('files.unwatch', view.id).catch(failed);
            };
        },
        onChange: listener => { if (!closed) changes.add(listener); return () => { changes.delete(listener); }; },
    };
    return { files, dispose: () => { if (closed) return; closed = true; off(); groups.clear(); changes.clear(); } };
}
