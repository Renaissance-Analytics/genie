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

/**
 * The registered agent BOUND TO a terminal, or undefined when that terminal has
 * none (genie#372).
 *
 * `markWorkspaceAgentReadyByTerminal` already ran this exact SELECT, but only
 * after an UPDATE — so the one question `agentUpgrade` has to answer, *"is this
 * caller already in AMS?"*, could not be asked without writing. A tool that
 * reports what is true must not have to change it first.
 */
export function getWorkspaceAgentByTerminal(terminalSpecId: string): WorkspaceAgentRow | undefined {
    return getDb()
        .prepare<[string], WorkspaceAgentRow>(
            `SELECT *, COALESCE(native_transport, transport) AS transport
               FROM workspace_agents
              WHERE terminal_spec_id = ?`,
        )
        .get(terminalSpecId);
}
