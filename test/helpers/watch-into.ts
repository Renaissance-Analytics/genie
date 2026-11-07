import type { FilesHost } from '../../src/main/files-host.js';
import { FilesWatchHub, nodeWatchSource } from '../../src/main/files-watch-hub.js';

/**
 * A workspace watched the way the window wires it (the host split, P2.2): the hub's real watcher, and its batches told to
 * the files host (`recordDiskChanges`), which is what `state()` reads. `onBatch` hears each batch's paths, as the panels do.
 */
export function watchInto(
    host: FilesHost,
    workspace: { id: string; path: string },
    options: { now?: () => number; onBatch?: (workspaceId: string, paths: readonly string[]) => void } = {},
): FilesWatchHub {
    const hub = new FilesWatchHub({
        source: nodeWatchSource,
        send: (_owner, event) => {
            if (event.kind !== 'changed') return;
            host.recordDiskChanges(event.workspaceId, event.changes);
            options.onBatch?.(event.workspaceId, event.changes.map((c) => c.path));
        },
        ...(options.now ? { now: options.now } : {}),
    });
    hub.subscribe('test-window', 'test-view', workspace, {});
    return hub;
}
