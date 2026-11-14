import type { StoreReplicas } from './agent-stores-replica.js';

/** Own the background read; a later change/reconnect notification retries it without replaying writes (#636). */
export function watchRegistryRefresh(
    source: Pick<StoreReplicas, 'onRegistryChanged'>,
    registry: { refresh(): Promise<void> },
    onError: (error: unknown) => void,
): () => void {
    let disposed = false;
    let reading = false;
    let dirty = false;
    const refreshPending = async (): Promise<void> => {
        reading = true;
        try {
            while (dirty && !disposed) {
                dirty = false;
                try { await registry.refresh(); }
                catch (error) {
                    // Reporting must not create the unhandled rejection this subscription owns.
                    try { onError(error); } catch { /* the reporter itself is unavailable */ }
                }
            }
        } finally { reading = false; }
    };
    const unsubscribe = source.onRegistryChanged(() => {
        if (disposed) return;
        dirty = true;
        if (!reading) void refreshPending();
    });
    return () => {
        if (disposed) return;
        disposed = true;
        dirty = false;
        unsubscribe();
    };
}
