import type { AgentRecord } from './identity.js';

/** The built-in OS agent is a reserved identity, never a workspace agent with the same name. */
export const OS_AGENT_NAME = 'genie';
export const OS_WORKSPACE = '__genie__';
export const OS_AGENT_POLICY_NOTE = 'Genie has full permissions and is reachable by every agent.';

export function isOsAgent(agent: { readonly name?: string | undefined; readonly workspaceId?: string | undefined }): boolean {
    return agent.workspaceId === OS_WORKSPACE && agent.name === OS_AGENT_NAME;
}

/** Normalize old persisted records and new writes, so a stale control cannot restrict the OS agent. */
export function withOsAgentPolicy(record: AgentRecord): AgentRecord {
    if (!isOsAgent(record) || (record.permissions === 'all' && record.accessScope === 'all' && record.autoApprove === true && record.manageTabs === true && record.drivePages === true)) return record;
    return { ...record, permissions: 'all', accessScope: 'all', autoApprove: true, manageTabs: true, drivePages: true };
}
