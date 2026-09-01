import type { WorkspaceAgentRole } from '../db';

/**
 * What role a NEW agent takes in its workspace.
 *
 * The AMS guide states that every workspace has a Workspace Agent (TWA) by
 * default — "its terminal is the one that drives most work there, and TWA is
 * the master of the agents it spawns". The role exists in the schema, and
 * `deleteWorkspaceAgent` refuses to delete a `role: 'workspace'` row. But
 * nothing ever CREATED one: on a workstation with 29 agents across a dozen
 * workspaces, `role = 'workspace'` had zero rows (genie#324).
 *
 * So the first agent registered in a workspace becomes that workspace's TWA,
 * and every one after it is specialized.
 *
 * A GApp's agent is excluded deliberately. It belongs to the app rather than to
 * the workspace, and the schema permits only ONE `role='workspace'` row per
 * workspace — handing that slot to a GApp would lock the workspace out of ever
 * having an agent of its own.
 *
 * Pure, so the decision is testable without a database.
 */
export function firstAgentRole(input: {
    /** Whether this workspace ALREADY has an agent holding the workspace role. */
    hasWorkspaceAgent: boolean;
    kind?: 'agent' | 'gapp';
}): WorkspaceAgentRole {
    if (input.kind === 'gapp') return 'gapp';
    // Asking "are there no agents yet?" is the wrong question: a workspace agent
    // can exist while other agents do too, and `idx_workspace_agents_master` is
    // a UNIQUE index on (workspace_id) WHERE role='workspace'. Claiming the role
    // a second time does not fall back — it throws, and the registration fails.
    return input.hasWorkspaceAgent ? 'specialized' : 'workspace';
}
