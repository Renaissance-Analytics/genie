import { slugsFor } from '../core/address.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import { workspaceNameFor } from './workspace-names.js';
import type { Store, WorkspaceRecord } from './store.js';

/**
 * GENIE-HOST'S OWN VIEW OF THE REGISTRY (the host split, P3.2). The host is the one writer of workspaces.json and
 * agents.json (windows write through it, agent-stores-host.ts); this is what it reads of them — the roster its tools and
 * approvals use, a workspace's path and default agent — with or without a window. It re-reads after every write.
 *
 * The workspaces' address slugs come from their NAMES: project.json's `name`, else the folder (workspace-names.ts) — read
 * here as the window reads them, so an address resolves the same with no window (P3.3a). A name a window says wins.
 */
export class HostRegistry {
    readonly #store: Pick<Store, 'readWorkspaces' | 'readAgents'>;
    #workspaces: readonly WorkspaceRecord[] = [];
    #agents: readonly AgentRecord[] = [];
    #names: ReadonlyMap<string, string> = new Map();

    constructor(store: Pick<Store, 'readWorkspaces' | 'readAgents'>) {
        this.#store = store;
    }

    async refresh(): Promise<void> {
        this.#workspaces = await this.#store.readWorkspaces();
        this.#agents = await this.#store.readAgents();
    }

    /** The workspaces' names as the window read them (project.json), for their address slugs. */
    setNames(names: ReadonlyMap<string, string>): void {
        this.#names = names;
    }

    listAgents(): readonly AgentRecord[] {
        return this.#agents;
    }

    find(id: AgentId | string): AgentRecord | null {
        return this.#agents.find((a) => a.id === id) ?? null;
    }

    listWorkspaces(): readonly WorkspaceRecord[] {
        return this.#workspaces;
    }

    workspace(id: string): WorkspaceRecord | null {
        return this.#workspaces.find((w) => w.id === id) ?? null;
    }

    defaultAgentOf(workspaceId: string): string | null {
        return this.workspace(workspaceId)?.defaultAgentId ?? null;
    }

    workspaceSlugs(): Map<string, string> {
        return slugsFor(this.#workspaces.map((w) => ({ id: w.id, path: w.path, name: this.#names.get(w.id) ?? workspaceNameFor(w.path) })));
    }
}
