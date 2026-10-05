/**
 * The production bindings for {@link sessionsFrom}'s ports — and nothing else.
 *
 * This is the one file in the module that touches a database, a broker, a disk and a
 * timer-owning singleton. It is deliberately thin: every decision worth checking has
 * been lifted into `./adapt.ts` (the two ids, naming a peer, dating a handoff) or
 * into the pure layers it delegates to. What is left here is forwarding, which a test
 * could only re-state.
 *
 * Called from `main/ipc.ts`, which ships with no test — so the less that lives here,
 * the more of this path is actually covered.
 */

import fs from 'node:fs';
import { getTerminalSpec, listWorkspaceAgents, listWorkspaces } from '../db';
import { handoffPath, readHandoff } from '../agents/handoff';
import { parseHandoff } from '../agents/handoff-parse';
import { agentInboxBroker } from '../agentinbox/broker';
import { listPendingQuestions } from '../ask/force-question';
import { agentPulse } from '../terminal/agent-pulse';
import { handoffAt, inboxAgentIdOf, mailFrom } from './adapt';
import type { AgentSession } from './model';
import { sessionsFrom, type SessionPorts } from './service';

/** The file's own mtime, or null when it cannot be stat'd. A real fact about the
 *  file, which is why it is the fallback for a note that does not date itself. */
function mtimeOf(file: string): number | null {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return null;
    }
}

export function productionPorts(): SessionPorts {
    return {
        workspaces: () => listWorkspaces().map((w) => ({ id: w.id, root: w.path })),

        agentRows: (workspaceId) => listWorkspaceAgents(workspaceId),

        workingTerminalIds: () => agentPulse.workingAgentTerminals(),

        questions: () => listPendingQuestions(),

        handoff: ({ name, workspaceRoot }) => {
            const parsed = parseHandoff(readHandoff(workspaceRoot, name));
            if (!parsed) return null;
            const at = handoffAt(parsed.at, mtimeOf(handoffPath(workspaceRoot, name)));
            // A note we cannot place in time at all is declined rather than given an
            // invented one — it would sort wrongly against everything else.
            return at === null ? null : { text: parsed.text, at };
        },

        mail: ({ specId }) => {
            if (!specId) return [];
            // THE TWO IDS: the broker answers to the terminal's own `meta.agent_id`,
            // never to `workspace_agents.id`. See `./adapt.ts`.
            const own = inboxAgentIdOf(getTerminalSpec(specId)?.meta ?? null);
            if (!own) return [];
            return mailFrom(agentInboxBroker.history({ agentId: own }), own);
        },

        // Not wired yet, on purpose. `observeWorkspaceAgents` in
        // `main/mcp/host-tools.ts` already performs all eighteen reads `diagnoseAgent`
        // needs, but it is private — and its own comment is why this does not
        // re-derive them: "Reading one id for both is not a subtle bug — it reports
        // every healthy agent on the machine as unreachable." Exporting it is a
        // change to that file, not a copy made here.
        ailment: () => null,

        now: () => Date.now(),
    };
}

/** Every agent's session, for the Deck. */
export function agentSessions(): AgentSession[] {
    return sessionsFrom(productionPorts());
}
