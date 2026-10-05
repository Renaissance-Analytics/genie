/**
 * Assemble every agent's session: read what Genie knows, attribute it, project it.
 *
 * Every read is a PORT. That is not ceremony — the production bindings reach a
 * database, the filesystem, the AgentInbox broker and a timer-owning singleton, and
 * `main/ipc.ts` (where this gets called from) ships with no test at all. Ports are
 * the only way the orchestration below is checked by anything.
 *
 * ## One bad read must not blank the surface
 *
 * This feeds the answer to "what needs me". A surface that says *nothing needs you*
 * because one handoff file was unreadable is worse than one that says nothing at
 * all, because the first is believed. So each per-agent read is isolated: a throw
 * degrades THAT fact to its honest empty value and the rest of the session still
 * reports.
 *
 * The degradations are ranked deliberately. Losing "is it mid-turn" is cosmetic;
 * losing "somebody is blocked on you" is not — so the question read is the one that
 * must survive, and the working-set read is allowed to fail around it.
 *
 * ## Why it includes agents the other surfaces hide
 *
 * `observeWorkspaceAgents` filters `!!agent.tui` — *"a row with no TUI is not
 * something any other surface shows"* — and the agent roster does the same. This
 * deliberately diverges: a registered agent nobody can see is the exact defect the
 * AMS grid was repaired to remove (*"a registered agent that was not running was
 * INVISIBLE"*), and the session model already has an honest answer for the case —
 * a null provider reads as `'unknown'` fidelity, which asks for a repair rather
 * than pretending to show a session. **If that turns out to be the wrong product
 * call, the policy belongs in the caller, not here.**
 */

import { gatherFloorInputs, type GatherQuestion } from './gather';
import { gatherAgentFromRow, type AgentRowish } from './from-rows';
import type { AgentSession } from './model';
import { projectFloorSession, type FloorHandoff, type FloorMessage } from './project-floor';

/** A workspace and where it lives on disk. */
export interface Workspaceish {
    id: string;
    root: string;
}

export interface SessionPorts {
    /** Every workspace. The one read with no partial answer available. */
    workspaces: () => readonly Workspaceish[];
    /** Registered agents in a workspace (`listWorkspaceAgents`). */
    agentRows: (workspaceId: string) => readonly AgentRowish[];
    /** `agentPulse.workingAgentTerminals()`. */
    workingTerminalIds: () => readonly string[];
    /** `listPendingQuestions()`, unattributed. */
    questions: () => readonly GatherQuestion[];
    /** The agent's last handoff, already parsed. */
    handoff: (agent: { agentId: string; name: string; workspaceRoot: string }) => FloorHandoff | null;
    /** Mail visible for an agent. */
    mail: (agent: { agentId: string; specId: string | null }) => readonly FloorMessage[];
    /** A triage ailment for an agent, or null. */
    ailment: (agent: { agentId: string; specId: string | null }) => string | null;
    now: () => number;
}

/** Run a read, and on failure return the honest empty value instead of throwing.
 *  The point is never to swallow a bug silently but to keep ONE unreadable fact
 *  from deciding that nothing needs the human. */
function safely<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}

export function sessionsFrom(ports: SessionPorts): AgentSession[] {
    const now = safely(ports.now, Date.now());
    const workspaces = safely(ports.workspaces, []);
    if (workspaces.length === 0) return [];

    // Read ONCE, not per agent: both are machine-wide lists, and asking per agent
    // would turn one query into one per agent for no extra truth.
    const workingTerminalIds = safely(ports.workingTerminalIds, []);
    const questions = safely(ports.questions, []);

    const out: AgentSession[] = [];

    for (const ws of workspaces) {
        // A corrupt workspace must not hide every agent on the machine.
        const rows = safely(() => ports.agentRows(ws.id), []);

        const agents = rows.map((row) => gatherAgentFromRow(row, ws.root));

        const handoffs = new Map<string, FloorHandoff>();
        const mail = new Map<string, readonly FloorMessage[]>();
        const ailments = new Map<string, string>();

        for (const a of agents) {
            const note = safely(
                () => ports.handoff({ agentId: a.agentId, name: a.name, workspaceRoot: ws.root }),
                null,
            );
            if (note) handoffs.set(a.agentId, note);

            const inbox = safely(() => ports.mail({ agentId: a.agentId, specId: a.specId }), []);
            if (inbox.length > 0) mail.set(a.agentId, inbox);

            const ailment = safely(() => ports.ailment({ agentId: a.agentId, specId: a.specId }), null);
            if (ailment) ailments.set(a.agentId, ailment);
        }

        const inputs = gatherFloorInputs(
            { agents, workingTerminalIds, questions, handoffs, mail, ailments },
            now,
        );
        for (const i of inputs) out.push(projectFloorSession(i));
    }

    return out;
}
