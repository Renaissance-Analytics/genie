import type { AgentRecord } from './identity.js';

/**
 * WHO MAY MESSAGE AN AGENT, AS ONE CHOICE (Tynn #526): nobody, this workspace, this workspace plus chosen agents, chosen
 * agents, or any workspace here. Stored as the agent's `accessScope` and its `accessAgents` list.
 */
export type AccessChoice = 'none' | 'self' | 'self+chosen' | 'chosen' | 'all';

export function accessChoice(_record: Pick<AgentRecord, 'accessScope'> & { readonly accessAgents?: readonly string[] | undefined }): AccessChoice {
    throw new Error('Tynn #526: not built yet');
}

export function accessFor(_choice: AccessChoice, _current: readonly string[] | null | undefined): { scope: 'none' | 'self' | 'all'; agents: string[] | null } {
    throw new Error('Tynn #526: not built yet');
}

export function toggleChosen(_list: readonly string[], _id: string, _on: boolean): string[] {
    throw new Error('Tynn #526: not built yet');
}
