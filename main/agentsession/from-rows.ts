/**
 * Map Genie's agent RECORD into the gatherer's input.
 *
 * Small, and it is the exact join where two old mistakes would creep back in.
 *
 * **The terminal-is-the-agent assumption.** `workspace_agents.terminal_spec_id` is
 * nullable, and a null one means the agent is DORMANT — a normal state, not a
 * missing value. The AMS grid already paid for reading it the other way: *"a
 * registered agent that was not running was INVISIBLE, so every `role: 'workspace'`
 * agent seeded since v50 has never been shown to anyone."*
 *
 * **Filling in a blank with a plausible default.** `tui` is nullable. Defaulting it
 * to `'claude'` would brand an agent with a provider it does not run and hand it a
 * fidelity it has not earned — `sessionFidelity` reads a null provider as `'unknown'`
 * deliberately, so the surface can offer a repair instead of an empty transcript.
 *
 * Takes a structural row rather than importing `WorkspaceAgentRow`, so this module
 * stays free of `../db` and testable without a database.
 */

import type { GatherAgent } from './gather';

/** The fields of a `workspace_agents` row this mapping reads. */
export interface AgentRowish {
    id: string;
    workspace_id: string;
    name: string;
    /** The provider id, or null when the record does not say. */
    tui: string | null;
    /** Where the agent runs, or null to mean "the workspace root". */
    boot_cwd: string | null;
    /** The bound terminal, or null while DORMANT. */
    terminal_spec_id: string | null;
}

/** Treat blank-but-present the same as absent. A record written with an empty
 *  string is not making a claim, and carrying `''` forward as a provider or a path
 *  turns a missing value into a wrong one. */
function present(value: string | null): string | null {
    const trimmed = (value ?? '').trim();
    return trimmed === '' ? null : trimmed;
}

export function gatherAgentFromRow(row: AgentRowish, workspaceRoot: string): GatherAgent {
    return {
        agentId: row.id,
        name: row.name,
        // Null stays null: dormant is a state, not a gap to fill.
        specId: row.terminal_spec_id,
        provider: present(row.tui),
        // `boot_cwd` is null for an agent that runs at the workspace root, which is
        // the common case rather than an error.
        cwd: present(row.boot_cwd) ?? workspaceRoot,
        workspaceId: row.workspace_id,
    };
}
