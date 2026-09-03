import { NEVER_NUDGED_AGENT_NAME } from './reserved-names';
import { GENIE_OS_AGENT } from './os-agent';

/**
 * How far apart two agents are woken by an upgrade (genie#353).
 *
 * Each nudge starts a model TURN, and a woken agent's first move is typically
 * `agentinbox receive` plus a `connectToGenie` — against an MCP server whose
 * process the upgrade has just replaced (#346). Waking a dozen agents in one
 * tick is a thundering herd at the exact moment connections are still being
 * re-established.
 */
export const AGENT_UPGRADE_NUDGE_INTERVAL_MS = 15_000;

/**
 * The stagger's clock, as an injected SEAM.
 *
 * `announceAgentUpgrade` stays synchronous and keeps returning a count, which is
 * the whole reason it is testable; making it `async` and awaiting real timers
 * would cost that and make the suite 15s slower per agent. Tests pass a
 * scheduler they drive themselves.
 */
export type UpgradeNudgeScheduler = (run: () => void, delayMs: number) => void;

const defaultScheduler: UpgradeNudgeScheduler = (run, delayMs) => {
    setTimeout(run, delayMs);
};

/**
 * Put the workstation operator in the audience, whatever the directory says
 * (genie#352).
 *
 * The audience is built from `agentInboxBroker.directory()`, and the OSA is the
 * one agent that can be missing from it — it is deliberately not a workspace
 * agent, so nothing about a project's lifecycle can delete or re-parent it. The
 * result was that the ONE broadcast whose purpose is telling agents the ground
 * moved under them reached every agent except the one whose job is the machine.
 *
 * Idempotent: a directory that DOES report the operator is returned unchanged,
 * so it is never nudged twice.
 */
export function withWorkstationOperator(
    agents: readonly UpgradeAnnouncementTarget[],
): UpgradeAnnouncementTarget[] {
    if (agents.some((agent) => agent.agentId === GENIE_OS_AGENT.id)) return [...agents];
    return [...agents, { agentId: GENIE_OS_AGENT.id, name: GENIE_OS_AGENT.name }];
}

/**
 * PURE. The agent ids an upgrade may nudge — everything except `general`.
 *
 * The owner's rule: *"No agents named general get any nudges or anything so they
 * don't start doing work on restart if any still exist."*
 *
 * v62 removes the DORMANT `general` agents, but the ones holding a live
 * terminal are deliberately left alone. A nudge lands in a TUI and starts a
 * turn, so nudging a survivor would set an agent nobody meant to create doing
 * work — the exact outcome being avoided.
 *
 * Deduplicates as the old `new Set(agentIds)` did, and matches the WHOLE name,
 * so `general-purpose` is a real agent and is nudged normally.
 */
export function nudgeableAgents(agents: readonly UpgradeAnnouncementTarget[]): string[] {
    const seen = new Set<string>();
    for (const agent of agents) {
        if (String(agent.name ?? '').trim().toLowerCase() === NEVER_NUDGED_AGENT_NAME) continue;
        seen.add(agent.agentId);
    }
    return [...seen];
}

export function formatAgentUpgradeMessage(version: string, changes: string[]): string {
    const summary = changes.length > 0
        ? ` What changed:\n${changes.map((change) => `- ${change}`).join('\n')}`
        : '';
    return `Genie upgraded to v${version}.${summary}\n\nIf this terminal predates AMS, call agentUpgrade now and follow its ordered migration guide.\n\nThis is a system notice; no reply is needed.`;
}

/** One agent the announcement may reach. */
export interface UpgradeAnnouncementTarget {
    agentId: string;
    /** The agent's NAME (its AgentInbox purpose). Required, not optional, so a
     *  caller cannot skip it and silently lose the `general` exclusion below. */
    name: string;
}

export function announceAgentUpgrade(input: {
    currentVersion: string;
    previousVersion?: string;
    /**
     * Who to tell. Carries the NAME as well as the id because an agent named
     * `general` must never be nudged (Tynn story #262) — see `nudgeableAgents`.
     */
    agents: UpgradeAnnouncementTarget[];
    changes: string[];
    send: (agentId: string, text: string) => boolean;
    /**
     * Re-establish this agent's `genie` MCP connection, BEFORE it is told
     * anything. An upgrade replaces the process behind the endpoint, so the
     * notice would otherwise arrive telling the agent to call tools that will
     * not answer — which reads as broken rather than disconnected. Optional:
     * callers with no way to reach a terminal should not have to invent one.
     */
    reconnect?: (agentId: string) => void;
    persist: (version: string) => void;
    /**
     * The stagger's clock (genie#353). Defaults to `setTimeout`; tests pass a
     * scheduler they drive synchronously so the suite does not grow 15s per
     * agent.
     */
    schedule?: UpgradeNudgeScheduler;
    /** Override the ~15s spacing. Named constant by default, never a literal. */
    intervalMs?: number;
}): number {
    if (!input.currentVersion || input.previousVersion === input.currentVersion) return 0;

    const text = formatAgentUpgradeMessage(input.currentVersion, input.changes);
    const targets = nudgeableAgents(input.agents);
    const schedule = input.schedule ?? defaultScheduler;
    const intervalMs = input.intervalMs ?? AGENT_UPGRADE_NUDGE_INTERVAL_MS;

    /**
     * One agent's whole nudge, in one tick. ORDER IS THE POINT — a notice that
     * lands first is read with dead tools — so the pair is kept ATOMIC rather
     * than spaced apart, which is exactly what staggering must not turn into a
     * race between one agent's reconnect and another's send.
     */
    const nudge = (agentId: string): void => {
        try {
            input.reconnect?.(agentId);
        } catch {
            // A failed reconnect leaves the agent worse informed, not silent —
            // the notice is the durable half and must not be lost to a TUI that
            // would not take the command.
        }
        input.send(agentId, text);
    };

    targets.forEach((agentId, index) => {
        // The first agent has nothing to wait behind; the rest are spaced.
        if (index === 0) nudge(agentId);
        else schedule(() => nudge(agentId), index * intervalMs);
    });

    // BEFORE the stagger finishes, deliberately. A crash part-way through must
    // not re-announce the whole fleet on the next boot — and with N agents the
    // last nudge is minutes away, which is a long time to leave that unrecorded.
    input.persist(input.currentVersion);
    // How many agents this announcement will nudge. It can no longer be "how
    // many sends succeeded": all but the first are still queued when this
    // returns. `send`'s own result is what the caller's mock asserts on.
    return targets.length;
}
