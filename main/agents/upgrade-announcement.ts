export function formatAgentUpgradeMessage(version: string, changes: string[]): string {
    const summary = changes.length > 0
        ? ` What changed:\n${changes.map((change) => `- ${change}`).join('\n')}`
        : '';
    return `Genie upgraded to v${version}.${summary}\n\nThis is a system notice; no reply is needed.`;
}

export function announceAgentUpgrade(input: {
    currentVersion: string;
    previousVersion?: string;
    agentIds: string[];
    changes: string[];
    send: (agentId: string, text: string) => boolean;
    persist: (version: string) => void;
}): number {
    if (!input.currentVersion || input.previousVersion === input.currentVersion) return 0;

    const text = formatAgentUpgradeMessage(input.currentVersion, input.changes);
    let sent = 0;
    for (const agentId of new Set(input.agentIds)) {
        if (input.send(agentId, text)) sent += 1;
    }
    input.persist(input.currentVersion);
    return sent;
}
