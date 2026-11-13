import type { StoreReplicas } from './agent-stores-replica.js';

/** Tests-first ownership seam for background registry reads during host reconnect (#636). */
export function watchRegistryRefresh(
    _source: Pick<StoreReplicas, 'onRegistryChanged'>,
    _registry: { refresh(): Promise<void> },
    _onError: (error: unknown) => void,
): () => void {
    return () => {};
}
