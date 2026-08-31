/**
 * Re-establishing an agent's `genie` MCP connection after Genie restarts.
 *
 * An upgrade replaces the process behind the MCP endpoint, so every running
 * agent's connection to `genie` is stale afterwards. The upgrade notice then
 * tells the agent to act using tools that will not answer — which reads as the
 * tools being broken rather than merely disconnected.
 *
 * HOW that is repaired differs per harness, and it is not a matter of taste:
 *
 *  - **claude** takes `/mcp reconnect genie`, typed into the prompt. It must go
 *    through the nudge machinery so it is SUBMITTED with the terminal's real
 *    submit bytes — a raw write plus CR types the command and leaves it sitting
 *    there, which is how a reconnect and an inbox notice ended up sharing one
 *    input line.
 *  - **codex** has NO equivalent. Verified against codex-cli 0.150.1 by the
 *    Codex agent itself: `codex mcp` exposes only list/get/add/remove/
 *    login/logout, with no single-server reconnect. Codex also does not
 *    discover the replacement URL on its own, because Genie passes it in launch
 *    config, so the running process keeps the old endpoint. The repair is a
 *    MANAGED RESTART, which resumes the session (`codex resume <id>`) against
 *    refreshed launch config and preserves the conversation.
 *  - everything else: nothing. Typing a guessed slash command into a live
 *    prompt is worse than leaving the reconnect to the agent.
 *
 * PURE: the caller performs whatever this returns.
 */

export type ReconnectStrategy =
    /** Type this into the prompt, through the nudge machinery. */
    | { kind: 'command'; text: string }
    /** Restart the agent's terminal; its session resumes against the new config. */
    | { kind: 'restart' }
    /** Nothing safe to do. */
    | { kind: 'none' };

export function reconnectStrategy(provider: string | null | undefined): ReconnectStrategy {
    if (provider === 'claude') return { kind: 'command', text: '/mcp reconnect genie' };
    // Out of band, never typed. Codex parks on key-driven modals -- update
    // pickers, approval requests, trust prompts -- where injected text is read
    // as an answer, and on the update picker option 1 runs a global npm install.
    if (provider === 'codex') return { kind: 'restart' };
    return { kind: 'none' };
}

/**
 * The TUI command that reconnects the `genie` server, or null when there is
 * none. Retained for callers that only handle the typed form.
 */
export function mcpReconnectCommand(provider: string | null | undefined): string | null {
    const strategy = reconnectStrategy(provider);
    return strategy.kind === 'command' ? strategy.text : null;
}
