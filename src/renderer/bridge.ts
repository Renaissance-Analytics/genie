import type { AgentRow } from '../core/dashboard-view.js';
import type { RailWorkspace } from '../core/rail-view.js';

/**
 * THE RENDERER'S ONLY WINDOW ONTO THE MAIN PROCESS.
 *
 * One narrow, declared surface. The renderer never reaches for `ipcRenderer` directly and
 * never holds a Node capability: the preload script implements exactly this interface over
 * `contextBridge` and nothing else crosses.
 *
 * ## Push, never poll
 *
 * `subscribe` is a subscription, not a timer. A dashboard that polls is a dashboard that is
 * wrong for up to its interval, and with thirty agents it is also a dashboard that reads the
 * session registry a hundred times a minute to learn nothing. The main process owns the
 * registry and says when it changed.
 *
 * ## `null` crosses the bridge intact
 *
 * Every nullable field on `AgentRow` and `RailWorkspace` means *"Genie cannot see this"*, and
 * the bridge must not helpfully coalesce one to a zero on the way through. The rule only
 * works if it holds end to end — a `?? 0` anywhere in the IPC layer silently converts "we
 * have not looked" into "we looked and it was none", and the UI has no way to tell.
 */
export interface GenieSnapshot {
    agents: readonly AgentRow[];
    workspaces: readonly RailWorkspace[];
    /** Things waiting on a human. `null` until the queue has actually been read. */
    deckCount: number | null;
    /** `null` until the workstation has been read — never a default `healthy: false`. */
    workstation: { name: string; healthy: boolean } | null;
}

export interface GenieBridge {
    /** The current snapshot. Resolves once; changes arrive through `subscribe`. */
    snapshot(): Promise<GenieSnapshot>;
    /** Called whenever the main process's view of the world changes. Returns an unsubscribe. */
    subscribe(onChange: (snapshot: GenieSnapshot) => void): () => void;
    /** Open an agent's session. Idempotent — reattaches rather than creating a second. */
    openAgent(agentId: string): void;
    addAgent(workspaceId: string): void;
}

declare global {
    interface Window {
        /**
         * Present only in the real app. It is optional on purpose: a renderer that assumes a
         * bridge cannot be rendered in a test, and the surfaces are then only ever checked by
         * launching the app — which is exactly how four releases shipped unexamined.
         */
        genie?: GenieBridge;
    }
}

/**
 * The snapshot a surface starts from before the bridge has answered.
 *
 * **Everything unknowable is `null`, and `agents` is empty with `workspaces` empty too.** This
 * is the state that renders skeletons, and it is deliberately NOT "zero agents in zero
 * workspaces": *"No agents"* and *"we have not heard yet"* are different claims, and first
 * paint must make the second one.
 */
export const EMPTY_SNAPSHOT: GenieSnapshot = {
    agents: [],
    workspaces: [],
    deckCount: null,
    workstation: null,
};
