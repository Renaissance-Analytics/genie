/**
 * "A list in this workspace changed" — the push signal behind the panel.
 *
 * The panel must not poll. Both lists are written from two directions at once —
 * an agent through the `lists` MCP tool, a person through the panel itself — so
 * a reader who only re-fetches on their own actions watches a stale list while
 * an agent fills it in.
 *
 * A module-level emitter rather than an argument threaded through every caller:
 * the MCP host and the IPC layer never meet, and the alternative is a
 * `onChanged` parameter on functions whose job has nothing to do with windows.
 */
type Listener = (workspaceId: string) => void;

const listeners = new Set<Listener>();

/** Subscribe. Returns the unsubscribe, so a test can leave no residue. */
export function onListsChanged(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

/**
 * Announce a change. Never throws: this is called from inside the code paths
 * that WRITE a list, and a listener that fails must not take the write with it —
 * the item really was added, and losing that to a broken window is worse than a
 * panel that refreshes a moment later.
 */
export function emitListsChanged(workspaceId: string): void {
    for (const fn of listeners) {
        try {
            fn(workspaceId);
        } catch {
            /* a subscriber's failure is not the writer's problem */
        }
    }
}
