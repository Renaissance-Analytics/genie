import type { AgentRecord } from './identity.js';

/**
 * WHO MAY MESSAGE AN AGENT, AS ONE CHOICE (Tynn #526; the owner, 2026-11-08: "the agent access settings needs to let me
 * choose other agents too, not just these"): nobody, this workspace, this workspace plus chosen agents, chosen agents, or
 * any workspace here. Stored as two fields on the RECIPIENT: `accessScope` (who it allows by workspace) and
 * `accessAgents` (who it allows by name, on top). Present-but-empty is the choice on with nobody chosen yet, so picking
 * "chosen agents" does not jump back to "nobody" before the first agent is ticked.
 */
export type AccessChoice = 'none' | 'self' | 'self+chosen' | 'chosen' | 'all';

type AccessFields = Pick<AgentRecord, 'accessScope'> & { readonly accessAgents?: readonly string[] | undefined };

export function accessChoice(record: AccessFields): AccessChoice {
    if (record.accessScope === 'all') return 'all';
    const chosen = Array.isArray(record.accessAgents);
    if (record.accessScope === 'none') return chosen ? 'chosen' : 'none';
    // `self`, and the old `specific` (shown as this workspace since #1664).
    return chosen ? 'self+chosen' : 'self';
}

/** What a choice saves: the scope, and the list (`null` = off). Switching between the two chosen choices keeps the list. */
export function accessFor(choice: AccessChoice, current: readonly string[] | null | undefined): { scope: 'none' | 'self' | 'all'; agents: string[] | null } {
    switch (choice) {
        case 'chosen': return { scope: 'none', agents: [...(current ?? [])] };
        case 'self+chosen': return { scope: 'self', agents: [...(current ?? [])] };
        case 'none':
        case 'self':
        case 'all':
            return { scope: choice, agents: null };
    }
}

/** One agent ticked or unticked; every other id is kept, a hibernated one the picker does not show included. */
export function toggleChosen(list: readonly string[], id: string, on: boolean): string[] {
    const rest = list.filter((x) => x !== id);
    return on ? [...rest, id] : rest;
}

/** Whether `fromId` is one of `to`'s chosen agents. A malformed list on disk lets nobody in. */
export function isChosen(to: { readonly accessAgents?: unknown }, fromId: string): boolean {
    return Array.isArray(to.accessAgents) && to.accessAgents.includes(fromId);
}
