import type { AgentStackEntry } from './agent-stack';

/**
 * What the avatar popover says about one agent: its STATUS, and its STATS.
 *
 * The popover shipped with a status line and nothing else, which made it a
 * tooltip. It is not a tooltip — when the sidebar is collapsed it is the ONLY
 * way to reach an agent, so it has to carry what the expanded grid carries.
 *
 * STATS ARE REAL OR ABSENT. Per-agent throughput does not exist in the
 * renderer — AgentPulse is keyed by workspace, not by agent — so nothing here
 * reports bytes or uptime. What the record actually holds is how many drivers
 * an agent has, how many are live, whether it is the workspace default, and
 * whether a name conflict is blocking it. A fabricated number would be worse
 * than a shorter list.
 *
 * PURE.
 */

/** Driver + running state, in that order: which TUI, and whether it is up. */
export function agentStackStatus(entry: AgentStackEntry): string {
    if (!entry.provider) return 'no driver yet';
    return `${entry.provider} · ${entry.running ? 'running' : 'stopped'}`;
}

/**
 * The countable facts. Always at least one entry — the popover renders these,
 * and a blank line reads as a rendering fault rather than as "nothing to say".
 */
export function agentStackStats(entry: AgentStackEntry): string[] {
    const stats: string[] = [];

    // The FRONTED tui is a driver too. Counting only sidecars describes the
    // wrong thing: an agent holding Claude and Codex has two drivers, not one
    // driver and one extra.
    const total = entry.sidecars.length + (entry.provider ? 1 : 0);
    const live =
        entry.sidecars.filter((s) => s.running).length + (entry.running && entry.provider ? 1 : 0);
    stats.push(
        total === 0
            ? 'no drivers'
            : `${total} driver${total === 1 ? '' : 's'} · ${live} live`,
    );

    // Why this agent boots from the workspace root and takes actions that name
    // no agent — the single most consequential thing about it.
    if (entry.role === 'workspace') stats.push('workspace default');

    // A conflict BLOCKS starting the agent, so it belongs with the numbers
    // rather than as a decoration on the avatar.
    if (entry.collisionGroup) stats.push('name conflict');

    return stats;
}
