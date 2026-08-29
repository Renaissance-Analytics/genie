export type AgentPanelAction = 'settings' | 'restart';

export function agentPanelActions(spec: { type: string; agent?: unknown }): AgentPanelAction[] {
    return spec.type === 'terminal' && typeof spec.agent === 'string'
        ? ['settings', 'restart']
        : [];
}
