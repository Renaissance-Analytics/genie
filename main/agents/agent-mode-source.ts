import { agentModeOf } from './agent-file';
import { DEFAULT_AGENT_MODE, type AgentMode } from './agent-mode';
import { getWorkspaceAgentById, getWorkspaceAgentByTerminal } from './lookup';

/**
 * Finding the agent whose `AGENT.md` declares the mode, from the coordinates a
 * nudge surface actually holds (genie#408).
 *
 * The wording lives in `agent-mode.ts` (pure), the storage lives in `AGENT.md`
 * (`agent-file.ts`), and this joins them to the database.
 *
 * ## Why it takes BOTH an id and a terminal
 *
 * There are two ids and they are not the same one:
 *
 *  - `workspace_agents.id` — stable, minted by `registerAgent`, and what
 *    `persona_path` hangs off.
 *  - the AgentInbox `agentId` — `terminal_specs.meta.agent_id`, minted FRESH by
 *    `spawnTerminal` on every launch (`ipc.ts`: *"a relaunch (a new terminal +
 *    a new agent id)"*).
 *
 * Migration v54 renamed each AMS row to adopt its inbox id, so the two agree —
 * until the next relaunch mints another one and they part again. The broker and
 * the upgrade announcement both address agents by the INBOX id, so a lookup
 * keyed on it alone finds no row for a relaunched agent and answers with the
 * default. An agent a human deliberately declared **Automated** would then be
 * spoken to as Manual, silently, which is precisely the class of wrong-and-
 * quiet this issue exists to remove.
 *
 * So the TERMINAL is tried first — `workspace_agents.terminal_spec_id` is the
 * binding Genie maintains across relaunches, and what
 * `markWorkspaceAgentReadyByTerminal` already keys on — and the id is the
 * fallback for an agent with no live terminal.
 *
 * **Every path degrades to {@link DEFAULT_AGENT_MODE}.** A missing row, an
 * agent with no `persona_path`, an unreadable file, a database not open yet
 * during boot — all mean "nobody declared this agent automated", which is
 * Manual. That is also the direction that fails safe: being wrong costs an
 * Automated agent one informational notice, not a Manual one being told to
 * restore everything.
 *
 * GUIDANCE, not enforcement. Nothing here is consulted to decide whether an
 * action is permitted — see `agent-mode.ts` and its guidance test.
 */

/** The one field of a `workspace_agents` row this decision reads. */
interface PersonaRow {
    persona_path: string | null;
}

export interface AgentModeLookups {
    byId: (agentId: string) => PersonaRow | undefined;
    byTerminal: (terminalSpecId: string) => PersonaRow | undefined;
    modeOf: (personaPath: string | null) => AgentMode;
}

/** Which agent a nudge is going to, as much of it as the caller knows. */
export interface AgentModeSubject {
    /** The AgentInbox id — per LAUNCH, so not reliable on its own. */
    agentId?: string | null;
    /** The terminal it is bound to. The durable join when there is one. */
    terminalId?: string | null;
}

/**
 * PURE. The mode for a subject, given the lookups — terminal first, then id.
 *
 * Pure and injected so the ORDER is testable without a `genie.db`: the order is
 * the whole decision, and a test that needed a database would not have been
 * written.
 */
export function resolveAgentMode(
    subject: AgentModeSubject,
    lookups: AgentModeLookups,
): AgentMode {
    try {
        const terminalId = String(subject.terminalId ?? '').trim();
        const row = terminalId ? lookups.byTerminal(terminalId) : undefined;
        if (row) return lookups.modeOf(row.persona_path);

        const agentId = String(subject.agentId ?? '').trim();
        const byId = agentId ? lookups.byId(agentId) : undefined;
        // The workstation operator lands here: deliberately not a workspace
        // agent, so it has no row and no AGENT.md to declare a mode on.
        return byId ? lookups.modeOf(byId.persona_path) : DEFAULT_AGENT_MODE;
    } catch {
        return DEFAULT_AGENT_MODE;
    }
}

const LIVE: AgentModeLookups = {
    byId: getWorkspaceAgentById,
    byTerminal: getWorkspaceAgentByTerminal,
    modeOf: agentModeOf,
};

/** The mode for an agent Genie is about to speak to. */
export function agentModeFor(subject: AgentModeSubject): AgentMode {
    return resolveAgentMode(subject, LIVE);
}

/** The mode of the agent bound to this terminal. */
export function agentModeByTerminal(terminalSpecId: string): AgentMode {
    return agentModeFor({ terminalId: terminalSpecId });
}
