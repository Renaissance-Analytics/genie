/**
 * What a standalone terminal window is showing — Tynn #447.
 *
 * Kept out of the page because the renderer's test environment has no DOM: a decision
 * inside a component is a decision nobody checks.
 *
 * Two shapes, and keeping them apart is the whole job:
 *
 * - **`spec`** — `?spec=<id>`. ATTACH to an existing `terminal_specs` row. This is how a
 *   window can host a real agent, because the spec is what carries the identity:
 *   `GENIE_TERMINAL_ID`, the per-terminal MCP token, AgentInbox, a roster entry, revival.
 * - **`scratch`** — no query. The tray's long-standing bare pty at home, with no workspace
 *   and no spec. Fine for a shell; it can never host an agent.
 *
 * Conflating them is the defect this prevents: minting a fresh pty for a window that was
 * meant to attach would leave the agent running in a terminal nobody is looking at.
 */

export type TerminalWindowView =
    | { kind: 'spec'; specId: string; cwd: string | null; workspaceId: string | null }
    | { kind: 'scratch' };

type Query = Record<string, string | string[] | undefined>;

/** First value wins for a repeated param — malformed input, and the opener wrote the first. */
function one(v: string | string[] | undefined): string | null {
    const raw = Array.isArray(v) ? v[0] : v;
    const trimmed = (raw ?? '').trim();
    return trimmed === '' ? null : trimmed;
}

export function parseTerminalWindowRoute(query: Query): TerminalWindowView {
    const specId = one(query.spec);
    // No spec, no attach. A `cwd` on its own is NOT an instruction to open there: nothing
    // registered it, so there is no spec to own the pty it would start.
    if (!specId) return { kind: 'scratch' };

    return {
        kind: 'spec',
        specId,
        // Both are a shortcut that saves a round trip, not a requirement. Refusing to
        // attach without them would turn a missing convenience into a broken window.
        cwd: one(query.cwd),
        workspaceId: one(query.ws),
    };
}
