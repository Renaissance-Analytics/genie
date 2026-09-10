import type { McpConfigSource } from '../agents/agent-manager-types';

/**
 * WHICH MCP servers Genie points at its OWN endpoint — the single declaration
 * behind both the writer and the post-upgrade reconnect (genie#613).
 *
 * ZERO RUNTIME IMPORTS, deliberately. `mcp/agent-config.ts` (the writer) reaches
 * `node:fs`, `../db` and the plugin registry; `agents/mcp-reconnect.ts` (the
 * reconnect) is PURE and must stay that way. The one fact they both need is the
 * LIST, so the list lives here and neither module has to import the other.
 *
 * ## The bug this exists to make impossible
 *
 * `mcp-reconnect.ts` hard-coded `/mcp reconnect genie`. Genie configures TWO
 * servers for a Claude agent, and a Genie upgrade replaces the process behind
 * both. The notice restored one and never mentioned the other, so
 * `genie-agentinbox-channel` — the PUSH delivery path — stayed down until a
 * human noticed. An agent whose channel is down looks healthy and receives
 * nothing.
 *
 * A second hard-coded name would have fixed that one instance and left the next
 * one to be found the same way. So the list is declared ONCE, here, and:
 *
 *  - `writeWorkspaceAgentMcp` ITERATES it, and its entry-builder tables are
 *    typed as `Record<GenieEndpointServer<'claude'>, …>` — adding a name below
 *    stops that file compiling until the server is actually written.
 *  - `reconnectStrategy` reads it, so the notice names every server without
 *    knowing any of them by name.
 *
 * ## What is deliberately NOT here
 *
 * `tynn`. Genie writes that entry too (`writeWorkspaceTynnMcp`), but it points
 * at Tynn's production endpoint, not at Genie's — a Genie upgrade does not
 * replace the process behind it. Its disconnects have a different cause
 * (Laravel Cloud sleeps the app after ~30 minutes without HTTP traffic, and a
 * long-lived MCP connection does not survive that), and folding it in here
 * would tell agents Genie had replaced something it had not.
 */

/** Genie's own MCP server — the tool channel. Configured for every harness. */
export const GENIE_SERVER_NAME = 'genie';

/**
 * The AgentInbox Channel bridge — Claude Code only.
 *
 * A stdio server Claude Code spawns (`claudeChannelEntry`), talking to the same
 * Genie endpoint over HTTP. It supervises its own connection and retries with
 * capped backoff, so an upgrade heals itself — EVERY error retries since
 * genie#619; the 401/403 that used to be fatal is not something Genie's server
 * can even produce. If the bridge process dies anyway, Claude Code marks the
 * server failed and only a reconnect brings it back — the case genie#613 was
 * filed on, and still the reason the notice has to name this server.
 */
export const AGENTINBOX_CLAUDE_CHANNEL_NAME = 'genie-agentinbox-channel';

/**
 * Every server Genie configures against its own endpoint, per config file.
 *
 * `as const` is load-bearing: the element types are string LITERALS, which is
 * what lets `GenieEndpointServer<'claude'>` below turn "the writer covers this
 * list" into a compile error rather than a thing to remember.
 */
export const GENIE_ENDPOINT_SERVERS = {
    /** `.mcp.json` — the `genie` http server plus the AgentInbox channel bridge. */
    claude: [GENIE_SERVER_NAME, AGENTINBOX_CLAUDE_CHANNEL_NAME],
    /** `.cursor/mcp.json` — no channel; the bridge is a Claude Code surface. */
    cursor: [GENIE_SERVER_NAME],
    /** `.codex/config.toml` — likewise. */
    codex: [GENIE_SERVER_NAME],
} as const satisfies Record<McpConfigSource, readonly string[]>;

/** The server names one config source carries, as a union of literals. */
export type GenieEndpointServer<S extends McpConfigSource> =
    (typeof GENIE_ENDPOINT_SERVERS)[S][number];

/**
 * Every name Genie OWNS, across all three configs — the union of the lists
 * above, de-duplicated.
 *
 * This is the membership test behind both guards in `agents/agent-mcp.ts`: a
 * human may not add a server under one of these names, and may not remove one.
 * Derived rather than listed, because listing is exactly what went wrong
 * (genie#618) — the ADD guard was written when there was one name and never
 * learned the second, so a hand-added `genie-agentinbox-channel` was accepted
 * straight over the push-delivery path.
 *
 * Deliberately source-agnostic. A name Genie owns anywhere is a name a human
 * should not be typing into any of these files; the alternative is a guard that
 * answers differently depending on which TUI the agent happens to run, for a
 * question that is really about who owns the word.
 */
export const GENIE_OWNED_SERVERS: readonly string[] = [
    ...new Set(Object.values(GENIE_ENDPOINT_SERVERS).flat()),
];

/** Whether Genie writes and owns this server name — {@link GENIE_OWNED_SERVERS}. */
export function isGenieOwnedServer(name: string): boolean {
    return GENIE_OWNED_SERVERS.includes(name);
}

/**
 * Which config an agent's TUI actually reads.
 *
 * A registered-but-never-started agent has `tui: null`, and it will almost
 * certainly start under Claude Code. Showing it nothing would read as "this
 * agent has no MCP servers", which is false and is exactly the invisible-set
 * problem `agent-mcp.ts` exists to end.
 *
 * The same default is what the reconnect falls back on when the provider is
 * unknown, and it errs in the safe direction: naming a server the harness turns
 * out not to have costs one refused slash command, while naming one too FEW is
 * genie#613 — a channel left silently dead.
 */
export function mcpSourceForTui(tui: string | null | undefined): McpConfigSource {
    if (tui === 'cursor') return 'cursor';
    if (tui === 'codex') return 'codex';
    return 'claude';
}

/**
 * PURE. Every Genie-endpoint MCP server THIS agent has — all of them stale
 * after an upgrade.
 */
export function genieEndpointServers(tui: string | null | undefined): readonly string[] {
    return GENIE_ENDPOINT_SERVERS[mcpSourceForTui(tui)];
}
