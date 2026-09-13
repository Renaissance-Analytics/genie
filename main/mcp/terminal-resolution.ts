/**
 * Which terminal an MCP call acts for — the one rule shared by Genie's in-process
 * server (`server.ts`) and the MCP shuttle (genie#346).
 *
 * Both answer on the same URL, so both must resolve a call's terminal identically,
 * and the only way that survives the next edit to either is for both to call this.
 *
 * The rule: a per-terminal (legacy) endpoint IS its terminal. A per-workspace
 * endpoint resolves to the explicit `terminalId` argument if it is a MEMBER of that
 * workspace, to the only terminal if there is exactly one, and otherwise to null.
 *
 * It used to fall back to the workspace's last-active terminal, which is
 * nondeterministic precisely when orchestration is busy — "last active" is whatever
 * some other agent touched most recently. Since `agentinbox` mints an agent's
 * durable identity onto whatever resolves here, that fallback could attach identity
 * to a stranger's pane (genie#17). Every pty carries GENIE_TERMINAL_ID, so a caller
 * that lands on null needs fixing, and {@link AMBIGUOUS_TERMINAL_MESSAGE} says how.
 */

/** What an endpoint token in a `.mcp.json` URL addresses. */
export type EndpointRoute =
    | { kind: 'terminal'; terminalId: string }
    | { kind: 'workspace'; workspaceId: string };

/** Refusal text for a `tools/call` that resolved no terminal. Actionable on purpose:
 *  it names the env var that fixes it, because silently acting on the wrong terminal
 *  is worse than a call the agent can retry. */
export const AMBIGUOUS_TERMINAL_MESSAGE =
    'Could not determine which terminal to act on. Pass `terminalId` — ' +
    'its value is in your GENIE_TERMINAL_ID environment variable. ' +
    '(This workspace has several terminals, or the id given is not one ' +
    'of them, so Genie will not guess.)';

export function resolveTerminal(
    route: EndpointRoute | null,
    workspaceTerminals: (workspaceId: string) => string[],
    argTerminalId: string | undefined,
): string | null {
    if (!route) return null;
    if (route.kind === 'terminal') return route.terminalId; // unambiguous

    const ids = workspaceTerminals(route.workspaceId);
    // An explicit id must be a MEMBER of this workspace. A stale id from elsewhere
    // resolves to nothing rather than silently landing on a local terminal — that
    // would be the same wrong-pane bug by another route.
    if (argTerminalId) return ids.includes(argTerminalId) ? argTerminalId : null;
    // Exactly one terminal is not a guess; keep working for the common case.
    if (ids.length === 1) return ids[0];
    return null;
}
