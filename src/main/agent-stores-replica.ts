import type { StoreName } from './agent-stores-host.js';
import type { AgentRecord } from '../core/identity.js';
import type { WorkspaceRecord } from './store.js';

/**
 * GENIE-HOST'S REGISTRY STORE (the host split, P3.2). The window's replicas of the host's stores that lived here (inbox,
 * attention, approvals, knowledge, settings, drafts) left with the engine link's `engine.stores` (Tynn #955, 2g-4d E2a):
 * a window reaches those over the protocol (features.act/snapshot, deck.watch, settings.watch, chatDrafts.*,
 * registry.write). What stays is the Registry store genie-host itself reads its registry through.
 */

/** A store method, by name, answered or refused in the stores' own words (AgentStoresService.call). */
export type StoresCall = (store: StoreName, method: string, args: readonly unknown[]) => Promise<unknown>;

/** What the registry store needs: the stores' call, and what their read of the registry's files set aside. */
export interface RegistryStorePort {
    readonly call: StoresCall;
    registryDropped(): readonly string[];
}

/**
 * A Registry over genie-host's registry files, read and written through the stores' one writer (P3.2): genie-host's
 * own phone Registry (genie-host.ts) uses it, so its writes go the way every other write to those files goes
 * (AgentStoresService), and every reader follows them. `dropped` is what the host's read of the files set aside.
 */
export class HostRegistryStore {
    readonly #call: StoresCall;
    readonly dropped: string[];

    constructor(port: RegistryStorePort) {
        this.#call = port.call;
        this.dropped = [...port.registryDropped()];
    }

    async readWorkspaces(): Promise<readonly WorkspaceRecord[]> { return (await this.#call('registry', 'readWorkspaces', [])) as WorkspaceRecord[]; }
    async readAgents(): Promise<readonly AgentRecord[]> { return (await this.#call('registry', 'readAgents', [])) as AgentRecord[]; }
    async readRunningAtQuit(): Promise<readonly string[]> { return (await this.#call('registry', 'readRunningAtQuit', [])) as string[]; }
    async readInterruptedAtQuit(): Promise<readonly string[]> { return (await this.#call('registry', 'readInterruptedAtQuit', [])) as string[]; }
    async beginRestore(): Promise<{ running: readonly string[]; interrupted: readonly string[] }> { return (await this.#call('registry', 'beginRestore', [])) as { running: string[]; interrupted: string[] }; }
    async restoreStarted(id: string): Promise<boolean> { return (await this.#call('registry', 'restoreStarted', [id])) === true; }
    async writeWorkspaces(workspaces: readonly WorkspaceRecord[]): Promise<void> { await this.#call('registry', 'writeWorkspaces', [workspaces]); }
    async writeAgents(records: readonly AgentRecord[]): Promise<void> { await this.#call('registry', 'writeAgents', [records]); }
    async writeRunningAtQuit(ids: readonly string[]): Promise<void> { await this.#call('registry', 'writeRunningAtQuit', [ids]); }
    async writeInterruptedAtQuit(ids: readonly string[]): Promise<void> { await this.#call('registry', 'writeInterruptedAtQuit', [ids]); }
}
