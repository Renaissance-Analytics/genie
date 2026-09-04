import { NEVER_NUDGED_AGENT_NAME } from './reserved-names';
import { GENIE_OS_AGENT } from './os-agent';
import { MANUAL_RECOVERY, recoveryInstruction, type McpRecovery } from './mcp-reconnect';
import { DEFAULT_AGENT_MODE, upgradeNoticeMode, type AgentMode } from './agent-mode';

/**
 * How long the announcement waits before it nudges ANYONE (genie#346).
 *
 * The upgrade killed every agent's `genie` MCP connection, and the harness
 * channels that carry AgentInbox re-attach on their own shortly after the new
 * server binds — the generated channel bridge retries with capped backoff
 * rather than dying on the first refused connection.
 *
 * Firing the first nudge in the boot tick meant that notice was composed while
 * no transport was bound, so the broker read "not attached" and typed it at the
 * prompt. That is the field evidence on #346: the message an agent most needs
 * after an upgrade is the one guaranteed to arrive the wrong way. Waiting out
 * one full backoff cap lets a healed channel report itself first, which puts
 * the notice back on the harness transport and leaves the PTY as the exception
 * it was meant to be.
 */
export const AGENT_UPGRADE_TRANSPORT_GRACE_MS = 10_000;

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

/**
 * The notice one agent gets, built from THAT agent's recovery (genie#346).
 *
 * The old text said *"call agentUpgrade now and follow its ordered migration
 * guide"* — and `agentUpgrade` is served by the process the upgrade just
 * replaced. The single instruction the agent was handed was the one it could
 * not follow, which is why a routine disconnect read as the tools being broken.
 *
 * So the order here is load-bearing: what happened, how to restore it, and only
 * THEN what to do once it answers again. `recovery` is required rather than
 * optional because a caller that cannot say how this agent recovers cannot
 * write an honest notice — it passes {@link MANUAL_RECOVERY} and tells the
 * agent to reconnect itself.
 *
 * `mode` is required for the same reason (genie#408): this notice ENDS in an
 * instruction, and whether that instruction may be imperative is the one thing
 * the composer cannot work out for itself. A caller that cannot say passes
 * `manual` — the default, and the direction that tells an agent to do less on
 * its own. It is GUIDANCE, not a permission boundary: the facts, the recovery
 * and the migration step are identical for both modes, and only the framing
 * differs.
 */
export function formatAgentUpgradeMessage(
    version: string,
    changes: string[],
    recovery: McpRecovery,
    mode: AgentMode,
): string {
    const summary = changes.length > 0
        ? ` What changed:\n${changes.map((change) => `- ${change}`).join('\n')}`
        : '';
    return `Genie upgraded to v${version}.${summary}\n\nYour \`genie\` MCP connection was replaced by the upgrade, so its tools do not answer until it is restored. ${recoveryInstruction(recovery)}\n\nOnce \`genie\` answers again: if this terminal predates AMS, call agentUpgrade and follow its ordered migration guide.\n\n${upgradeNoticeMode(mode)}\n\nThis is a system notice; no reply is needed.`;
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
     *
     * RETURNS what it did, so the notice can say so. A reconnect that was
     * refused (a terminal mid-turn, an agent with no resumable session) and one
     * that ran are different facts, and an agent told the wrong one acts on it.
     * Returning nothing — or throwing — degrades to {@link MANUAL_RECOVERY}:
     * Genie does not know that anything was repaired, so it says so.
     */
    reconnect?: (agentId: string) => McpRecovery | void;
    /**
     * THIS agent's mode (genie#408). The mode belongs to the AGENT, not the
     * fleet: one workspace can hold a supervising Automated agent and a Manual
     * one a person drives, and both are woken by this one announcement.
     *
     * Optional, and a throw is caught, because resolving it means a database
     * read and a file on disk — neither may be able to cost an agent its
     * upgrade notice. Absent or failed degrades to {@link DEFAULT_AGENT_MODE}.
     */
    mode?: (agentId: string) => AgentMode;
    persist: (version: string) => void;
    /**
     * The stagger's clock (genie#353). Defaults to `setTimeout`; tests pass a
     * scheduler they drive synchronously so the suite does not grow 15s per
     * agent.
     */
    schedule?: UpgradeNudgeScheduler;
    /** Override the ~15s spacing. Named constant by default, never a literal. */
    intervalMs?: number;
    /**
     * Override the head-start every agent gets before the first nudge
     * ({@link AGENT_UPGRADE_TRANSPORT_GRACE_MS}). Named constant by default.
     */
    graceMs?: number;
}): number {
    if (!input.currentVersion || input.previousVersion === input.currentVersion) return 0;

    const targets = nudgeableAgents(input.agents);
    const schedule = input.schedule ?? defaultScheduler;
    const intervalMs = input.intervalMs ?? AGENT_UPGRADE_NUDGE_INTERVAL_MS;
    const graceMs = input.graceMs ?? AGENT_UPGRADE_TRANSPORT_GRACE_MS;

    /**
     * One agent's whole nudge, in one tick. ORDER IS THE POINT — a notice that
     * lands first is read with dead tools — so the pair is kept ATOMIC rather
     * than spaced apart, which is exactly what staggering must not turn into a
     * race between one agent's reconnect and another's send.
     *
     * The message is composed HERE, per agent, from what the reconnect actually
     * managed to do. Built once for the fleet it could only be a guess, and the
     * guess was wrong for every provider Genie cannot reconnect.
     */
    const nudge = (agentId: string): void => {
        let mode: AgentMode = DEFAULT_AGENT_MODE;
        try {
            mode = input.mode?.(agentId) ?? DEFAULT_AGENT_MODE;
        } catch {
            // A mode that cannot be read is an UNDECLARED mode, and undeclared
            // is Manual. Losing the whole notice over it would trade a wording
            // difference for silence.
            mode = DEFAULT_AGENT_MODE;
        }
        let recovery: McpRecovery = MANUAL_RECOVERY;
        try {
            recovery = input.reconnect?.(agentId) ?? MANUAL_RECOVERY;
        } catch {
            // A failed reconnect leaves the agent worse informed, not silent —
            // the notice is the durable half and must not be lost to a TUI that
            // would not take the command. It degrades to the manual notice, so
            // the agent is told how to reconnect ITSELF rather than being handed
            // a message that assumes the tools are live.
            recovery = MANUAL_RECOVERY;
        }
        input.send(
            agentId,
            formatAgentUpgradeMessage(input.currentVersion, input.changes, recovery, mode),
        );
    };

    // NOTHING goes out in the boot tick, not even the first agent: the grace is
    // what lets a healed harness channel report itself before Genie decides
    // whether the notice rides that channel or the keyboard (genie#346).
    targets.forEach((agentId, index) => {
        schedule(() => nudge(agentId), graceMs + index * intervalMs);
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
