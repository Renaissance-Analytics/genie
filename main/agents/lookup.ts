import { getDb, type WorkspaceAgentRow } from '../db';

/**
 * A registered agent BY ID — the one `workspace_agents` lookup that never
 * existed. Every accessor `main/db.ts` already has keys on (workspace, name)
 * or (workspace, provider, name), because that is what registration and
 * `runAgent` need to resolve. Deleting one starts from an id instead — the id
 * is all a context-menu row carries (`AgentGridRow.id`) — so this is the
 * smallest read that was missing, kept in its own file rather than added to
 * `main/db.ts` while another agent owns it.
 */
export function getWorkspaceAgentById(agentId: string): WorkspaceAgentRow | undefined {
    return getDb()
        .prepare<[string], WorkspaceAgentRow>(
            `SELECT *, COALESCE(native_transport, transport) AS transport
               FROM workspace_agents
              WHERE id = ?`,
        )
        .get(agentId);
}
