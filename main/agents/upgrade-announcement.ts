export function formatAgentUpgradeMessage(version: string, changes: string[]): string {
    const summary = changes.length > 0
        ? ` What changed:\n${changes.map((change) => `- ${change}`).join('\n')}`
        : '';
    return `Genie upgraded to v${version}.${summary}\n\nIf this terminal predates AMS, call agentUpgrade now and follow its ordered migration guide.\n\nThis is a system notice; no reply is needed.`;
}

export function announceAgentUpgrade(input: {
    currentVersion: string;
    previousVersion?: string;
    agentIds: string[];
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
    for (const agentId of new Set(input.agentIds)) {
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
