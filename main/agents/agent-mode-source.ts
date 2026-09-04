import { agentModeOf } from './agent-file';
import { DEFAULT_AGENT_MODE, type AgentMode } from './agent-mode';
import { getWorkspaceAgentById, getWorkspaceAgentByTerminal } from './lookup';

/**
 * Resolving an agent's mode from the two coordinates the nudge surfaces
 * actually hold — an AgentInbox agent id, or a terminal (genie#408).
 *
 * The wording lives in `agent-mode.ts` (pure), the storage lives in `AGENT.md`
 * (`agent-file.ts`), and this is the only place that reaches BOTH the database
 * and the disk to join them. Kept apart from either so the broker and the
 * announcement stay testable without a workspace or a `genie.db`.
 *
 * **Every path degrades to {@link DEFAULT_AGENT_MODE}.** A missing row, an
 * agent with no `persona_path`, an unreadable file, a database that is not open
 * yet during boot — all of them mean "nobody declared this agent automated",
 * which is Manual. That is also the direction that fails safe: the cost of
 * being wrong is an Automated agent told to do less on its own for one notice,
 * not a Manual one told to restore everything.
 *
 * GUIDANCE, not enforcement. Nothing here is consulted to decide whether an
 * action is permitted — see `agent-mode.ts` and its guidance test.
 */

/** The mode declared by this agent's own `AGENT.md`, or Manual. */
export function agentModeById(agentId: string): AgentMode {
    try {
        const row = getWorkspaceAgentById(String(agentId ?? ''));
        // The workstation operator is deliberately NOT a workspace agent, so it
        // has no row and no AGENT.md — it resolves to Manual like anything else
        // that has never been declared.
        return row ? agentModeOf(row.persona_path) : DEFAULT_AGENT_MODE;
    } catch {
        return DEFAULT_AGENT_MODE;
    }
}

/** The mode of the agent bound to this terminal, or Manual when it has none. */
export function agentModeByTerminal(terminalSpecId: string): AgentMode {
    try {
        const row = getWorkspaceAgentByTerminal(String(terminalSpecId ?? ''));
        return row ? agentModeOf(row.persona_path) : DEFAULT_AGENT_MODE;
    } catch {
        return DEFAULT_AGENT_MODE;
    }
}
