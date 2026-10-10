import { agentRecord, mintAgentId, type AgentRecord, type AgentId } from '../core/identity.js';
import { agentRowFor, type LiveSession } from '../core/roster.js';
import type { GenieSnapshot } from '../renderer/bridge.js';
import { Store, type WorkspaceRecord } from './store.js';

/**
 * THE REGISTRY — the main process's single answer to "what is going on".
 *
 * Records come from the `Store`; live state comes from whatever sessions are running; the
 * snapshot is the join. Every surface reads this one object, so there is one place for the
 * question and no second copy to disagree with it.
 *
 * ## Capacity is counted in SESSIONS, never in processes
 *
 * §2.5, and it is worth stating in the file that would otherwise be tempted. "3 of 5 running"
 * is a property of this map. **Never `ptys.length`, never a process scan.** The previous build
 * counted ptys, so removing ptys from agents broke fifty-two tests — a number that only looks
 * absurd until you notice what it means: fifty-two places had agreed that an agent's existence
 * was a terminal's existence.
 *
 * ## Push, never poll
 *
 * `onChange` fires when something actually changed. A renderer that polls is wrong for up to
 * its interval and, with thirty agents, reads this map a hundred times a minute to learn
 * nothing.
 */

/**
 * The OS agent's name and its non-workspace.
 *
 * `OS_WORKSPACE` is not a workspace anybody has and never appears in the rail: it exists so
 * the one agent that belongs to no workspace still has a well-formed record.
 */
export const OS_AGENT_NAME = 'genie';
export const OS_WORKSPACE = '__genie__';

/** What the registry can see of a running session. Supplied by whatever owns the sessions. */
export type SessionProbe = (id: AgentId) => LiveSession | null;

export class Registry {
    readonly #store: Store;
    #workspaces: readonly WorkspaceRecord[] = [];
    #agents: readonly AgentRecord[] = [];
    #probe: SessionProbe = () => null;
    #listeners = new Set<(snapshot: GenieSnapshot) => void>();
    #workstation: { name: string; healthy: boolean } | null = null;
    #loaded = false;

    constructor(store: Store) {
        this.#store = store;
    }

    /** Problems found while loading, for the surface to report rather than swallow. */
    readonly faults: string[] = [];

    async load(workstation: { name: string; healthy: boolean }): Promise<void> {
        this.#workspaces = await this.#store.readWorkspaces();
        this.#agents = await this.#store.readAgents();
        this.faults.push(...this.#store.dropped);
        this.#workstation = workstation;
        this.#loaded = true;

        await this.#seedOsAgent();
        this.#emit();
    }

    /**
     * The OS agent, seeded once.
     *
     * The rail carries a `genie` row unconditionally — *"the OS agent, always present"* — and
     * a row that navigates to an agent which does not exist lands on a not-found. That is the
     * same class of failure as a disabled control: the product offering something it cannot
     * deliver. So the record is real, has a real id, and persists like any other.
     *
     * Its `workspaceId` is `OS_WORKSPACE`, which is deliberately not a workspace anybody has.
     * It is *"the one agent that is not in a workspace"*, and filing it under a real one would
     * inflate that workspace's count — the group header's `4 agents` is a census people read.
     */
    async #seedOsAgent(): Promise<void> {
        if (this.#agents.some((a) => a.workspaceId === OS_WORKSPACE && a.name === OS_AGENT_NAME)) return;

        const record = agentRecord({
            id: mintAgentId(),
            workspaceId: OS_WORKSPACE,
            provider: 'claude',
            name: OS_AGENT_NAME,
        });
        this.#agents = [...this.#agents, record];
        await this.#store.writeAgents(this.#agents);
    }

    setProbe(probe: SessionProbe): void {
        this.#probe = probe;
    }

    /** Count of live sessions — the only correct source for "how many agents are running". */
    get runningCount(): number {
        return this.#agents.filter((a) => this.#probe(a.id)?.running === true).length;
    }

    snapshot(): GenieSnapshot {
        const now = () => Date.now();

        return {
            /**
             * The Dashboard's census — **workspace agents only**.
             *
             * The OS agent is deliberately excluded. It appears in no workspace group, so a
             * header chip counting it would read `1 working` with no working row anywhere to
             * account for it, and a number a reader cannot trace to a row is worse than no
             * number. It is reachable by its own route from the rail, and `find` still
             * resolves it.
             *
             * This was the other way round for one commit: seeding the OS agent into `agents`
             * broke six tests that asserted exact counts, and mass fixture churn is the signal
             * to suspect the guard rather than the fixtures. It was the guard.
             */
            agents: this.#agents
                .filter((record) => record.workspaceId !== OS_WORKSPACE)
                .map((record) => agentRowFor(record, this.#probe(record.id), now)),
            // `agentsKnown` is TRUE only once the store has actually been read. Before that the
            // rail must render no counts at all: a `0` on first paint says "this workspace is
            // empty" when the truth is "nobody has looked yet".
            workspaces: this.#workspaces.map((w) => ({ id: w.id, path: w.path, agentsKnown: this.#loaded })),
            // `null` until the Deck exists to read it. Not `0` — that would be a badge-sized
            // claim that nothing needs the user, made by a surface that has not been built.
            deckCount: null,
            workstation: this.#workstation,
        };
    }

    subscribe(listener: (snapshot: GenieSnapshot) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Call when live session state changed. The registry does not watch anything itself. */
    touch(): void {
        this.#emit();
    }

    async addWorkspace(workspace: WorkspaceRecord): Promise<void> {
        if (this.#workspaces.some((w) => w.id === workspace.id)) return;
        this.#workspaces = [...this.#workspaces, workspace];
        await this.#store.writeWorkspaces(this.#workspaces);
        this.#emit();
    }

    /**
     * Register an agent. **Consumes no resources** — no process, no session, no pty, nothing.
     *
     * §6.2 separates registering from starting on purpose: an identity should be creatable,
     * nameable and persistable without anything running, so that a workspace can be set up
     * before anyone is ready to spend a provider turn on it.
     */
    async register(input: { workspaceId: string; provider: AgentRecord['provider']; name: string }): Promise<AgentRecord> {
        const record = agentRecord({ id: mintAgentId(), ...input });
        this.#agents = [...this.#agents, record];
        await this.#store.writeAgents(this.#agents);
        this.#emit();
        return record;
    }

    /** The OS agent's record. Always present after `load`. */
    osAgent(): AgentRecord | null {
        return this.#agents.find((a) => a.workspaceId === OS_WORKSPACE && a.name === OS_AGENT_NAME) ?? null;
    }

    find(id: AgentId): AgentRecord | null {
        return this.#agents.find((a) => a.id === id) ?? null;
    }

    #emit(): void {
        const snapshot = this.snapshot();
        for (const listener of this.#listeners) listener(snapshot);
    }
}
