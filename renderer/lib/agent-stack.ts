import type { AgentGridRow } from './ams-grid';

/**
 * The AVATAR STACK on a workspace row, and what its popover says.
 *
 * A row shows a name, a sparkline and an IssueWatch square — nothing about WHO
 * is working in that workspace. The stack answers that at a glance; hovering it
 * gives each agent's status: which TUI is active, and whether any sidecars are
 * running.
 *
 * It reads the same rows the grid does, deliberately. Deriving a second answer
 * from terminal specs is exactly how the row and the grid would come to disagree
 * — which is the class of bug this whole redesign started from.
 *
 * PURE, so what the popover claims is testable without a DOM.
 */

export interface AgentStackEntry {
    id: string;
    name: string;
    /** The TUI currently driving it, or null when it has never been started. */
    provider: string | null;
    /** A user-set avatar; absent means fall back to the provider's brand mark. */
    avatar: string | null;
    running: boolean;
    /** Every TUI it holds BESIDES the visible one. */
    sidecars: Array<{ provider: string; running: boolean }>;
    collisionGroup: string | null;
    /** The workspace-default designation, so the popover can say why this agent
     *  boots from the root — and so its controls can offer to clear it. */
    role: 'workspace' | 'specialized' | 'gapp';
}

export interface AgentStack {
    /** The avatars to draw, capped. */
    entries: AgentStackEntry[];
    /** How many did not fit. */
    overflow: number;
    total: number;
    running: number;
}

export interface AgentStackInput {
    rows: readonly AgentGridRow[];
    /** How many avatars the row has space for. */
    max?: number;
}

const DEFAULT_MAX = 4;

export function agentStack(input: AgentStackInput): AgentStack {
    // Orphans are leftover terminals offered for repair, not agents. Putting one
    // in the stack would re-create the phantom-square bug on a new surface.
    const agents = input.rows.filter((row) => row.kind === 'agent');
    const max = input.max ?? DEFAULT_MAX;

    // With a cap, WHO gets a slot matters: the agents doing work are worth one.
    const ordered = [...agents].sort((a, b) => Number(b.running) - Number(a.running));

    const entries = ordered.slice(0, max).map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        provider: row.provider,
        avatar: row.avatar,
        running: row.running,
        // "Has a codex sidecar" and "that sidecar is LIVE" are different facts,
        // and the second is the one that costs money.
        sidecars: row.tuis
            .filter((tui) => !tui.fronted)
            .map((tui) => ({ provider: tui.provider, running: tui.running })),
        collisionGroup: row.collisionGroup,
    }));

    return {
        entries,
        overflow: Math.max(0, agents.length - entries.length),
        total: agents.length,
        running: agents.filter((row) => row.running).length,
    };
}
