export interface RevivalSpec {
    id: string;
    type: string;
    workspace_id: string | null;
    meta?: { agent?: string; agent_id?: string; was_running?: boolean; user_stopped?: boolean } | null;
}

/** Only observed running intent is restorable; the OSA owns its own boot path. */
export function agentsToRevive<T extends RevivalSpec>(specs: readonly T[]): T[] {
    return specs.filter(s => s.type === 'terminal' && !!s.workspace_id && !!s.meta?.agent
        && s.meta.was_running === true && !s.meta.user_stopped
        && s.meta.agent_id !== 'genie:workstation');
}
