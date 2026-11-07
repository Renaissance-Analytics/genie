import { vi } from 'vitest';
import type { FilesHubEvent, FilesWant } from '../../src/main/files-watch-hub.js';
import { FilesWatchHub } from '../../src/main/files-watch-hub.js';
import { localFilesClient } from '../../src/renderer/local-files-client.js';
import { localPageClient } from '../../src/renderer/local-content-client.js';
import { verifiedBlobClient } from '../../src/renderer/blob-reader.js';
import type { LocalUploadClient } from '../../src/core/local-content.js';
import { resourceDoor, resultValue } from './local-resource-door.js';

export const watchTick = () => new Promise<void>(resolve => setImmediate(resolve));
export async function localWatchDoor(cleanups: Array<() => Promise<void>>) {
    const listeners = new Set<(event: FilesHubEvent) => void>();
    const watchers: Array<{ root: string; closed: boolean; emit(path: string): void }> = [];
    const timers: Array<() => void> = [];
    const data = { tree: { 'a.txt': 'modified' } as Record<string, 'modified' | 'added' | 'deleted' | 'untracked'> };
    const git = vi.fn(async () => data.tree), repo = vi.fn(async (_root: string, rel: string) => ({ ok: true as const, value: { branch: rel || 'main', changes: [] } }));
    const hub = new FilesWatchHub({ source: (root, emit) => { const watcher = { root, closed: false, emit }; watchers.push(watcher); return { close: () => { watcher.closed = true; } }; },
        gitTree: git, repoStatus: repo as never, send: (_owner, event) => { for (const listener of listeners) listener(event); },
        schedule: fn => { let live = true; timers.push(() => { if (live) fn(); }); return () => { live = false; }; } });
    let register = async (_id: string) => {};
    const watch = vi.fn(async (id: string, workspaceId: string, want: FilesWant) => {
        if (workspaceId !== 'work' && workspaceId !== 'other') return false;
        await register(id);
        hub.subscribe('main', id, { id: workspaceId, path: `/synthetic/${workspaceId}` }, want);
        return true;
    });
    const unwatch = vi.fn((id: string) => hub.unsubscribe('main', id));
    const filesWatch = { watch, unwatch, subscribe: (listener: (event: FilesHubEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const f = await resourceDoor(cleanups, {}, { filesWatch });
    cleanups.push(async () => hub.close());
    type Raw = Awaited<ReturnType<typeof f.raw>>;
    // Use the EXISTING Files projection decoder against this raw connection's watchState result.
    // It is not another door, and it cannot read refs belonging to a different raw/client connection.
    const readState = async (raw: Raw, viewId: string): Promise<unknown> => {
        const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
            const result = await raw.call(method, args);
            if (result.kind === 'result' && !result.ok) throw new Error(result.reason);
            return resultValue<T>(result);
        };
        const blobs = verifiedBlobClient({ open: (kind, ref) => call('blob.open', kind, ref), read: (id, offset, length) => call('blob.read', id, offset, length), close: id => call('blob.close', id) });
        const pages = localPageClient({ open: (kind, ref) => call('page.open', kind, ref), next: cursor => call('page.next', cursor), close: cursor => call('page.close', cursor) });
        const reader = localFilesClient({ read: (_method, ...args) => call('files.watchState', ...args), release: ref => call('content.release', ref), blobs, pages, uploads: {} as LocalUploadClient });
        return reader.files.tree(viewId);
    };
    return { ...f, hub, watchers, data, git, repo, watch, unwatch, readState,
        holdRegistration: (fn: (id: string) => Promise<void>) => { register = fn; },
        fire: (event: FilesHubEvent) => { for (const listener of listeners) listener(event); },
        emit: async (paths: readonly string[], workspaceId = 'work') => {
            const watcher = watchers.findLast(w => !w.closed && w.root === `/synthetic/${workspaceId}`);
            if (!watcher) throw new Error('no held watcher for the positive control');
            for (const path of paths) watcher.emit(path);
            for (const timer of timers.splice(0)) timer();
            await watchTick();
        } };
}
