import { NEVER_NUDGED_AGENT_NAME } from './reserved-names';

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
}): number {
    if (!input.currentVersion || input.previousVersion === input.currentVersion) return 0;

    const text = formatAgentUpgradeMessage(input.currentVersion, input.changes);
    let sent = 0;
    for (const agentId of nudgeableAgents(input.agents)) {
        // ORDER IS THE POINT. A notice that lands first is read with dead tools.
        try {
            input.reconnect?.(agentId);
        } catch {
            // A failed reconnect leaves the agent worse informed, not silent —
            // the notice is the durable half and must not be lost to a TUI that
            // would not take the command.
        }
        if (input.send(agentId, text)) sent += 1;
    }
    input.persist(input.currentVersion);
    return sent;
}
