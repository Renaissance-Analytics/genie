import type { AgentRow, Fidelity } from '../core/dashboard-view.js';
import type { RailWorkspace, Surface } from '../core/rail-view.js';
import type { LiveSession } from '../core/roster.js';
import type { TimedEvent } from '../core/stream-view.js';

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
    /**
     * `null` until the store has actually been read.
     *
     * **Not `[]`.** The two are different claims and they get different surfaces: an empty
     * array means Genie looked and this machine has no workspaces, which is a first run and
     * deserves an invitation; `null` means nobody has looked yet, which deserves a skeleton.
     *
     * This distinction was missing for exactly one commit, and the Dashboard's brand-new
     * first-run state rendered "Nothing is being worked on yet" before the bridge had
     * answered — a confident claim about a machine nobody had asked. An older test caught it.
     */
    workspaces: readonly RailWorkspace[] | null;
    /** Things waiting on a human. `null` until the queue has actually been read. */
    deckCount: number | null;
    /** `null` until the workstation has been read — never a default `healthy: false`. */
    workstation: { name: string; healthy: boolean } | null;
}

/**
 * One agent's full state — what the Agent view needs.
 *
 * Fetched per agent rather than carried in the snapshot: a ledger is thousands of rows, and
 * pushing every agent's to every renderer on every event would send the whole estate's
 * history down the wire to redraw one line.
 */
export interface AgentDetail {
    agent: { id: string; name: string; provider: string; fidelity: Fidelity; cwd: string };
    /** `null` when the agent is registered but not running. Not an error. */
    session: LiveSession | null;
    rows: readonly TimedEvent[];
    turns: number;
    /** `null` when the provider reports no cost. codex reports none — so there is no row. */
    cost: number | null;
    /** Why a start was refused, if one was. Reported, never swallowed. */
    refusal: string | null;
}

export interface GenieBridge {
    /** The current snapshot. Resolves once; changes arrive through `subscribe`. */
    snapshot(): Promise<GenieSnapshot>;
    /** Called whenever the main process's view of the world changes. Returns an unsubscribe. */
    subscribe(onChange: (snapshot: GenieSnapshot) => void): () => void;

    /** One agent's detail, or `null` for an id that is not registered. */
    agentDetail(agentId: string): Promise<AgentDetail | null>;
    /** Changes to one agent. Separate from `subscribe` so a ledger is not broadcast. */
    subscribeAgent(agentId: string, onChange: (detail: AgentDetail | null) => void): () => void;

    /** Start or REATTACH a session. Never creates a second for the same agent. */
    openAgent(agentId: string): void;
    /** Stop means stop: the provider tree goes, and the capacity slot frees. */
    stopAgent(agentId: string): void;
    prompt(agentId: string, text: string): void;
    addAgent(workspaceId: string): void;
    /**
     * Open the folder picker and register what the user chose.
     *
     * The first-run invitation's one action. Genie never guesses a path and never writes into
     * a folder before showing what it found there.
     */
    addWorkspace(): void;
}

/**
 * Which surfaces this build can actually render.
 *
 * Exported from here because both the shell and the rail read it, and the rail's rows are
 * DERIVED from it — see `railSurfacesFor`. Two lists would drift, and the failure is silent in
 * both directions: a row that navigates nowhere, or a surface nothing points at.
 *
 * **Add a surface in the commit that makes it render, never before.**
 */
export const SERVABLE: readonly Surface[] = ['dashboard', 'agent'];

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
    workspaces: null,
    deckCount: null,
    workstation: null,
};
