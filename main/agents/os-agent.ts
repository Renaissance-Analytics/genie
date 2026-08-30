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

export const GENIE_OS_TERMINAL_ID = 'genie-workstation-agent';

const FULL_ACCESS_FLAGS: Partial<Record<string, string>> = {
    claude: '--dangerously-skip-permissions',
    codex: '--yolo',
};

/** OSA-only authority. Ordinary project agents continue to use owner settings. */
export function osAgentLaunchCommand(provider: string, command: string): string {
    const flag = FULL_ACCESS_FLAGS[provider];
    if (!flag || command.split(/\s+/).includes(flag)) return command.trim();
    return `${command.trim()} ${flag}`;
}

export function authorizeOsAgentBoot(
    provider: string,
    nativeTransportVerified: boolean,
): OsAgentAuthorization {
    if ((provider === 'claude' || provider === 'codex') && !nativeTransportVerified) {
        return {
            allowed: false,
            reason: `${provider} must verify its native AgentInbox transport before Genie can complete workstation setup.`,
        };
    }
    return { allowed: true };
}

export function obsoleteOsAgentSpecIds(
    specs: readonly { id: string; meta?: { agent_id?: string } | null }[],
): string[] {
    return specs
        .filter(
            (spec) =>
                spec.meta?.agent_id === GENIE_OS_AGENT.id &&
                spec.id !== GENIE_OS_TERMINAL_ID,
        )
        .map((spec) => spec.id);
}

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
