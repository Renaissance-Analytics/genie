import { randomUUID } from 'node:crypto';
import { FILES_EVENT_BYTES, treeChangesOf, type FilesWatchPush, type FilesWatchState, type FilesWireEvent } from '../core/local-files-watch.js';
import type { FilesHubEvent, FilesWant } from './files-watch-hub.js';

export interface FilesWatchPort {
    exists?(workspaceId: string): boolean;
    watch(id: string, workspaceId: string, want: FilesWant): boolean | Promise<boolean>;
    unwatch(id: string): void;
    subscribe(listener: (event: FilesHubEvent) => void): () => void;
}
interface View { id: string; key: string; workspaceId: string; want: FilesWant }
const wantFrom = (raw: unknown): FilesWant => {
    const w = (raw ?? {}) as { git?: unknown; repos?: unknown };
    const repos = Array.isArray(w.repos) ? w.repos.filter((r): r is string => typeof r === 'string') : [];
    return { ...(w.git === true ? { git: true } : {}), ...(repos.length ? { repos } : {}) };
};

/** One admitted connection's views and latest COMPUTED state. Refetch never calls git or the watcher. */
export class LocalFilesWatches {
    readonly #port: FilesWatchPort | undefined;
    readonly #views = new Map<string, View>();
    readonly #registrations = new Set<View>();
    readonly #states = new Map<string, FilesWatchState>();
    #revision = 0;
    #closed = false;
    constructor(port?: FilesWatchPort) { this.#port = port; }
    async watch(viewId: unknown, workspaceId: unknown, rawWant: unknown): Promise<boolean> {
        if (this.#closed || !this.#port || typeof viewId !== 'string' || typeof workspaceId !== 'string' || this.#port.exists?.(workspaceId) === false) return false;
        const view: View = { id: randomUUID(), key: viewId, workspaceId, want: wantFrom(rawWant) }, previous = this.#views.get(viewId);
        this.#views.set(viewId, view);
        this.#registrations.add(view);
        // Replacing wants in the SAME workspace must not drop its only watcher or pending batch.
        // A workspace switch releases the old workspace before registering the new one.
        if (previous && previous.workspaceId !== workspaceId) { this.#unwatch(previous); this.#release(previous.workspaceId); }
        try {
            const registered = await this.#port.watch(view.id, workspaceId, view.want);
            if (!registered || this.#closed || this.#views.get(viewId) !== view) {
                if (this.#views.get(viewId) === view) {
                    if (previous && this.#registrations.has(previous)) this.#views.set(viewId, previous);
                    else this.#views.delete(viewId);
                }
                this.#unwatch(view); this.#release(workspaceId); return false;
            }
            if (previous) this.#unwatch(previous);
            return true;
        } catch (error) {
            if (this.#views.get(viewId) === view) {
                if (previous && this.#registrations.has(previous)) this.#views.set(viewId, previous);
                else this.#views.delete(viewId);
            }
            this.#unwatch(view); this.#release(workspaceId); throw error;
        }
    }
    unwatch(viewId: unknown): boolean {
        if (typeof viewId !== 'string') return false;
        const view = this.#views.get(viewId);
        if (view) { this.#views.delete(viewId); this.#unwatch(view); this.#release(view.workspaceId); }
        for (const pending of this.#registrations) if (pending.key === viewId) this.#unwatch(pending);
        return true;
    }
    state(viewId: unknown): FilesWatchState | null {
        const view = typeof viewId === 'string' && !this.#closed ? this.#views.get(viewId) : undefined;
        if (!view) throw new Error('there is no Files view with that id on this connection');
        return this.#states.get(view.workspaceId) ?? null;
    }
    event(event: FilesHubEvent): FilesWatchPush | null {
        const views = [...this.#views.values()].filter(v => v.workspaceId === event.workspaceId);
        if (this.#closed || !views.length || (event.kind === 'git' && !views.some(v => v.want.git || v.want.repos?.length))) return null;
        const old = this.#states.get(event.workspaceId), revision = ++this.#revision;
        const state: FilesWatchState = { revision, pathsRevision: old?.pathsRevision ?? 0, gitRevision: old?.gitRevision ?? 0, event: { ...old?.event } };
        const next: FilesWatchState = event.kind === 'changed'
            ? { ...state, pathsRevision: revision, event: { ...state.event, paths: event.changes.map(c => c.path) } }
            : { ...state, gitRevision: revision, event: { ...state.event, git: { ...(event.tree ? { tree: event.tree } : {}), ...(event.repos ? { repos: event.repos } : {}) } } };
        this.#states.set(event.workspaceId, next);
        /*
         * WHAT CROSSES IS ONLY WHAT CHANGED (Tynn #523). The kept state above is whole (a refetch reads it); the push is not:
         * a batch carries its paths alone, and a git run carries the tree as its changes against the last tree this
         * connection was sent. The window holds that tree; one it does not hold makes it refetch the whole state.
         */
        const prevTree = old?.event.git?.tree;
        const wire: FilesWireEvent = event.kind === 'changed'
            ? { paths: next.event.paths! }
            : { git: {
                ...(event.tree ? (prevTree && old!.gitRevision > 0 ? { treeChanges: { base: old!.gitRevision, ...treeChangesOf(prevTree, event.tree) } } : { tree: event.tree }) : {}),
                ...(event.repos ? { repos: event.repos } : {}),
            } };
        const push = { workspaceId: event.workspaceId, revision, state: { ...next, event: wire } };
        return Buffer.byteLength(JSON.stringify(push)) <= FILES_EVENT_BYTES ? push : { workspaceId: event.workspaceId, revision, changed: 'refetch' };
    }
    dispose(): void {
        if (this.#closed) return; this.#closed = true;
        for (const view of this.#registrations) this.#unwatch(view);
        this.#views.clear(); this.#states.clear();
    }
    #release(workspaceId: string): void {
        if (![...this.#views.values()].some(v => v.workspaceId === workspaceId)) this.#states.delete(workspaceId);
    }
    #unwatch(view: View): void {
        this.#registrations.delete(view);
        try { this.#port?.unwatch(view.id); } catch { console.warn('[genie] a Files view could not be released'); }
    }
}
