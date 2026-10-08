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
import {
    getDb,
    getTerminalSpec,
    updateTerminalSpec,
    listWorkspaceAgents,
    listWorkspaces,
    recordAgentUsage,
    agentBudgetFor,
    agentSpendForDay,
    workspaceAgentBySpecId,
} from '../db';
import { DeclaredSessionStore } from './declared-store';
import { localDayKey } from '../agents/usage-rollup';
import type { BudgetGatePorts } from '../agents/budget-gate';
import { forceQuestion } from '../ask/force-question';
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

        // The declared overlay — see `mergeDeclared`. Null for every pty agent.
        declared: (agentId) => declaredSessions.get(agentId),
    };
}

/**
 * The one declared-session store for this process.
 *
 * Module-level because the ACP transport and the session readers are different call paths
 * that must see the same sessions: `startAcpForSpec` folds updates in, `agentSessions()`
 * reads them out, and a second instance would mean the Deck rendering a session nobody is
 * updating.
 *
 * Telemetry is written through `recordAgentUsage`, injected here rather than imported by
 * the store, so the store stays testable with no database and `createHostCore` can use it
 * without pulling in Electron.
 */
export const declaredSessions = new DeclaredSessionStore({
    record: (e) => {
        try {
            recordAgentUsage(getDb(), { ...e, costUsd: e.costUsd ?? null });
        } catch (err) {
            // Telemetry must never take a turn down with it. A lost row is a gap in a
            // measurement; a throw inside a notification handler kills the subscription and
            // the agent stops reporting anything at all.
            console.warn('[telemetry] agent usage row dropped:', err);
        }
    },
    now: () => Date.now(),

    /**
     * Spec -> agent, read fresh each time.
     *
     * Not cached: an agent switches drivers, and each driver is its own spec. A cache here
     * would answer with the agent that USED to own this spec, and the declared session would
     * land on the wrong one.
     */
    /**
     * Persist the provider's session id the moment it arrives.
     *
     * Into `meta.chat_session_id` — the SAME field the pty path writes from
     * `captureSessionByDetect`, and the same field `capturedSessionId` reads. That is the
     * point: `restartOptionsFor` already keys `canResume` off it, so an ACP agent becomes
     * resumable through the machinery that already exists rather than a parallel one.
     *
     * The AgentInbox broker is told too, exactly as the pty path does, so a restart keeps the
     * agent's mail bound to the same conversation.
     */
    onSessionIdCaptured: (specId, sessionId) => {
        if (!specId) return;
        try {
            const spec = getTerminalSpec(specId);
            if (!spec) return;
            updateTerminalSpec(specId, {
                meta: {
                    ...spec.meta,
                    chat_session_id: sessionId,
                    // Not minted any more: this one came FROM the provider, so a later
                    // restart may continue it.
                    chat_session_id_minted: false,
                },
            });
            const agentId = spec.meta?.agent_id;
            if (typeof agentId === 'string') agentInboxBroker.setChatSession(agentId, sessionId);
            // DYNAMIC, to break a cycle rather than to be clever: `terminal/ipc` imports
            // `declaredSessions` from this module, so importing its broadcaster statically
            // would close the loop. Reimplementing the broadcast here is the worse option —
            // it does three things (local windows, mobile, MCP topology) and a second copy
            // would drift. This runs once per session, not per update.
            void import('../terminal/ipc').then((m) => m.broadcastTerminalSpecsChanged());
        } catch (err) {
            // A failed write loses resume for this session, which is bad — but throwing
            // inside a notification handler kills the subscription and loses everything
            // after it too.
            console.warn(`[acp] could not persist the session id for ${specId}:`, err);
        }
    },

    identityForSpec: (specId) => {
        const row = workspaceAgentBySpecId(getDb(), specId);
        if (!row) return null;
        return {
            agentId: row.id,
            specId,
            provider: row.tui ?? null,
            name: row.name,
            cwd: row.boot_cwd ?? '',
            workspaceId: row.workspace_id,
        };
    },
});


/**
 * The budget gate, bound to the real database and the real question path.
 *
 * Owner decisions: per agent, **stop-and-ask** (park the NEXT turn, never interrupt one in
 * flight), and the action is itself a per-agent setting.
 *
 * `ask` raises a real ForceTheQuestion rather than logging: a budget that silently stops an
 * agent is indistinguishable from Genie being broken, and the whole value of stop-and-ask is
 * that the owner finds out, from the agent that is parked, with the numbers that parked it.
 */
export function budgetGatePorts(): BudgetGatePorts {
    return {
        budgetFor: (agentId) => agentBudgetFor(getDb(), agentId),
        spendFor: (agentId) => agentSpendForDay(getDb(), agentId, localDayKey(Date.now())),
        ask: (c) => {
            const lines = c.crossed.map(
                (x) => `- **${x.cap}**: ${x.actual} of ${x.limit} used today`,
            );
            void forceQuestion([
                {
                    header: 'Budget',
                    question: [
                        `**${c.agentId} has reached its daily budget, so its next turn is parked.**`,
                        lines.join('\n'),
                        'Nothing was interrupted — the turn in flight finished. It will not start another until you decide.',
                    ].join('\n\n'),
                    options: [
                        {
                            label: 'You: let it carry on today',
                            description: 'Agent: clears the cap for the rest of today and starts the next turn.',
                        },
                        {
                            label: 'You: keep it parked',
                            description: 'Agent: leaves it parked. Nothing is lost; it resumes tomorrow or when you raise the cap.',
                        },
                    ],
                },
            ]).catch(() => {
                // A question that cannot be raised must not also stop the gate from
                // reporting. The turn stays parked either way.
            });
        },
        warn: (c) => {
            if (c.unenforceable.length > 0) {
                // The honest case: a cap is set and CANNOT fire. Silence here is the failure
                // mode — the owner believes a cost cap protects a pty agent, and it does not.
                for (const u of c.unenforceable) {
                    console.warn(
                        `[budget] ${c.agentId}: the ${u.cap} cap cannot be enforced — ${u.because}`,
                    );
                }
                return;
            }
            console.warn(
                `[budget] ${c.agentId} is over budget and set to warn: ` +
                    c.crossed.map((x) => `${x.cap} ${x.actual}/${x.limit}`).join(', '),
            );
        },
        now: () => Date.now(),
    };
}

/** Every agent's session, for the Deck. */
export function agentSessions(): AgentSession[] {
    return sessionsFrom(productionPorts());
}
