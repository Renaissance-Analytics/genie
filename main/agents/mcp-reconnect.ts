/**
 * Re-establishing an agent's `genie` MCP connection after Genie restarts.
 *
 * An upgrade replaces the process behind the MCP endpoint, so every running
 * agent's connection to `genie` is stale afterwards. The upgrade notice then
 * tells the agent to act — call `agentUpgrade`, follow the migration guide —
 * using tools that will not answer. To the agent this reads as the tools being
 * broken rather than merely disconnected, which is a much more alarming thing to
 * report and a much harder one to recover from.
 *
 * So the reconnect goes to the terminal FIRST. Not alongside the notice, and not
 * as advice inside it: by the time an agent is reading prose it has already
 * tried and failed.
 *
 * PURE: the caller owns delivery.
 */

/**
 * The TUI command that reconnects the `genie` server, or null when the form for
 * that harness is not known.
 *
 * Null means SEND NOTHING. This text is typed into a live prompt, so a guessed
 * command for a harness that has no such thing is junk in somebody's input box —
 * worse than leaving the reconnect to the agent. Codex does this differently and
 * is deliberately absent until its own agent confirms the form.
 */
export function mcpReconnectCommand(provider: string | null | undefined): string | null {
    return provider === 'claude' ? '/mcp reconnect genie' : null;
}
