import { issueWatchNotice, issueWatchPrefsFor, wantsEvent, type IssueWatchSetting, type IwEvent } from '../core/issue-watch.js';

/**
 * ISSUEWATCH REACHES THE AGENTS (Tynn #806; the owner: "push updates from github directly to agent workflow like the
 * inbox pushes … the agent mode — manual/auto — influences this push msg").
 *
 * What changed in a Tynn project reaches the agents of the Genie workspace linked to it (project.json `tynn.projectId`),
 * each by its OWN setting (`issueWatchPrefsFor`): the kinds it chose, worded for its mode (`issueWatchNotice`). This is
 * the queue the inbox's own delivery reads (main wires it into `wireInboxPush` as a second source): a notice goes in as
 * Genie's turn when the agent can take one, is OUT until that turn ends, and is told again if it was not delivered —
 * the inbox's semantics exactly, so an IssueWatch notice is a visible turn in the agent's Stream, never a hidden rider.
 * Several changes waiting are told as ONE notice; what arrives while one is out waits for the next.
 */
export interface IssueWatchDeliveryPorts {
    readonly agents: () => ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly workspaceId: string;
        readonly createdAt: string;
        readonly mode: 'automated' | 'manual';
        readonly issueWatch?: IssueWatchSetting | undefined;
    }>;
    /** The Genie workspace linked to a Tynn project, by its project.json `tynn.projectId`; `null` = none. */
    readonly workspaceFor: (projectId: string) => { id: string; name: string } | null;
}

export class IssueWatchDelivery {
    readonly #ports: IssueWatchDeliveryPorts;
    /** Waiting to be told, per agent, with its workspace's name. */
    readonly #pending = new Map<string, { workspace: string; events: IwEvent[] }>();
    /** Out: told in a turn that has not ended yet. */
    readonly #out = new Map<string, { workspace: string; events: IwEvent[] }>();
    readonly #listeners = new Set<(agentId: string) => void>();

    constructor(ports: IssueWatchDeliveryPorts) {
        this.#ports = ports;
    }

    /** What changed in a project (the client's): queued for each agent that hears it, and the delivery told. */
    onEvents(projectId: string, events: readonly IwEvent[]): void {
        const workspace = this.#ports.workspaceFor(projectId);
        if (!workspace) return;
        const agents = this.#ports.agents();
        const touched: string[] = [];
        for (const agent of agents) {
            if (agent.workspaceId !== workspace.id) continue;
            const prefs = issueWatchPrefsFor(agent, agents);
            const heard = events.filter((e) => wantsEvent(prefs, e.kind));
            if (heard.length === 0) continue;
            const waiting = this.#pending.get(agent.id) ?? { workspace: workspace.name, events: [] };
            waiting.events.push(...heard);
            this.#pending.set(agent.id, waiting);
            touched.push(agent.id);
        }
        for (const id of touched) for (const l of this.#listeners) l(id);
    }

    /** The delivery's trigger: an agent has something waiting. */
    onQueued(listener: (agentId: string) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** The notices due now — for agents that can take a turn and have nothing out — each marked out. */
    due(input: { run: (agentId: string) => number | null }): Array<{ agentId: string; text: string }> {
        const due: Array<{ agentId: string; text: string }> = [];
        const agents = this.#ports.agents();
        for (const [agentId, waiting] of [...this.#pending]) {
            if (this.#out.has(agentId) || input.run(agentId) === null) continue;
            const agent = agents.find((a) => a.id === agentId);
            if (!agent) { this.#pending.delete(agentId); continue; }
            this.#pending.delete(agentId);
            this.#out.set(agentId, waiting);
            due.push({ agentId, text: issueWatchNotice(waiting.events, { workspace: waiting.workspace, mode: agent.mode }) });
        }
        return due;
    }

    /** The out notice's fate: delivered is done; not delivered goes back, ahead of anything that arrived meanwhile. */
    settled(agentId: string, delivered: boolean): void {
        const out = this.#out.get(agentId);
        if (!out) return;
        this.#out.delete(agentId);
        if (delivered) return;
        const later = this.#pending.get(agentId);
        this.#pending.set(agentId, { workspace: out.workspace, events: [...out.events, ...(later?.events ?? [])] });
    }

    /** Whether a stopped agent is woken for it: `push` wakes, as mail does; `next-turn` waits for it to be running. */
    wakes(agentId: string): boolean {
        const agents = this.#ports.agents();
        const agent = agents.find((a) => a.id === agentId);
        return agent !== undefined && issueWatchPrefsFor(agent, agents).delivery === 'push';
    }
}
