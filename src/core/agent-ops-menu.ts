import { ACP_PROVIDERS } from './engine.js';

/**
 * THE AGENT'S OPERATIONS MENU (§6.2) — one table of what the header's overflow offers. The component
 * maps over it; a test reads it without opening anything. Delete-for-real is the one danger item.
 * An Observed (Take Over) agent gets nothing: Genie does not manage it (§1).
 */
export interface AgentOpsItem {
    readonly id: string;
    readonly label: string;
    readonly hint: string;
    readonly danger?: true;
}

/**
 * `state.running` = the agent has a live session. Then the menu leads with **Stop agent**: END the session (§6.2 stop —
 * identity, persona, inbox and history kept). Separate from `Stop this turn` beside the running turn, which ends the
 * TURN and keeps the agent: the two were one button, so interrupting a turn killed the agent (the owner, 2026-10-15).
 */
export function agentOpsMenu(agent: { provider: string; fidelity: string }, providers: readonly string[] = ACP_PROVIDERS, state: { running: boolean } = { running: false }): AgentOpsItem[] {
    if (agent.fidelity !== 'declared') return [];
    return [
        ...(state.running ? [{ id: 'stop-agent', label: 'Stop agent', hint: 'ends its session; identity, inbox and history kept' }] : []),
        { id: 'restart-graceful', label: 'Restart gracefully', hint: 'same conversation; refuses if it cannot resume' },
        { id: 'restart-fresh', label: 'Restart fresh', hint: 'discards the conversation on purpose' },
        ...providers.filter((p) => p !== agent.provider).map((p) => ({ id: `switch:${p}`, label: `Switch driver to ${p}`, hint: 'identity, inbox, history and prompt carry across' })),
        { id: 'diagnose', label: 'Diagnose', hint: 'names a cause and the repair that fits' },
        { id: 'delete-unmount', label: 'Unmount from Genie…', hint: 'keeps every .agents/* file' },
        { id: 'delete-delete', label: 'Delete…', hint: 'removes the persona folder too', danger: true },
    ];
}
