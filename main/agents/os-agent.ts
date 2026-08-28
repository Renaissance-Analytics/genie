/**
 * Genie's one built-in workstation identity. It is intentionally not persisted
 * as a workspace agent: deleting a project or rebuilding workspace state cannot
 * delete, rename, re-parent, or accidentally grant it project ownership.
 */
export const GENIE_OS_AGENT = Object.freeze({
    id: 'genie:workstation',
    name: 'Genie',
    purpose: 'Operate and maintain this workstation.',
    role: 'workstation-operator' as const,
    workspaceId: null,
    mutable: false,
    skills: ['genie-agent-builder'] as const,
});

export type OsAgentTarget =
    | { kind: 'workstation' }
    | { kind: 'project'; workspaceId: string };

export type OsAgentAuthorization =
    | { allowed: true }
    | { allowed: false; reason: string };

/** Update only launch details; immutable identity and security fields survive. */
export function osAgentMetaForProvider(
    existing: Record<string, unknown>,
    provider: string,
    command: string,
): Record<string, unknown> {
    return { ...existing, agent: provider, agent_command: command };
}

/** Project work must be handed to that project's Workspace Agent. */
export function authorizeOsAgentTarget(target: OsAgentTarget): OsAgentAuthorization {
    if (target.kind === 'workstation') return { allowed: true };
    return {
        allowed: false,
        reason:
            `Genie is the workstation operator and cannot work directly on project ` +
            `workspace "${target.workspaceId}". Hand that work to the workspace's own agent.`,
    };
}
