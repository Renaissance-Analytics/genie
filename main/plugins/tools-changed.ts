/**
 * "The set of plugin tools may have changed" — announced by every management
 * operation that can change which plugins are enabled or trusted (genie#346).
 *
 * The MCP shuttle serves `tools/list` from the manifest Genie last published, so
 * Genie has to republish when plugin tools move. Kept a zero-import leaf so the
 * plugin layer can announce without knowing who listens.
 */

const listeners = new Set<() => void>();

/** Hear about it. Returns the unsubscribe. */
export function onPluginToolsChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function notifyPluginToolsChanged(): void {
    for (const listener of listeners) {
        try {
            listener();
        } catch {
            /* a listener must not be able to fail a plugin operation */
        }
    }
}
