import { randomBytes } from 'node:crypto';

/**
 * THE TAKE OVER ENVIRONMENT CONTRACT (§1, §6.9).
 *
 * Three variables in every terminal Genie opens for a TUI: `GENIE_MCP_URL` (the loopback MCP
 * server), `GENIE_TERMINAL_ID` (which terminal — the tools' attribution argument) and
 * `GENIE_MCP_TOKEN` (a per-process bearer prism-mcp-server checks in constant time).
 *
 * The token travels as a VARIABLE, never in the URL: a URL gets logged, pasted into bug reports and
 * shown in a TUI's /mcp listing. The TUI's MCP config REFERENCES the variable — Claude Code
 * interpolates `${GENIE_MCP_TOKEN}` in a header, Codex names it with `bearer_token_env_var` — so the
 * literal never lands in a file. The VM acceptance measures both before the contract claims "not on
 * disk"; until then it claims exactly what this file does.
 *
 * Loopback is not an authorization boundary (any local process, any open web page), which is why
 * the token exists; a non-loopback URL is refused here because it would make the token the ONLY
 * thing between the internet and the agent harness.
 */

export interface McpEndpoint {
    readonly mcpUrl: string;
    readonly terminalId: string;
    readonly token: string;
}

/** 32 bytes of randomness, url-safe base64 (43 chars), new for every Genie process. */
export function mintMcpToken(): string {
    return randomBytes(32).toString('base64url');
}

function assertLoopback(mcpUrl: string): URL {
    let url: URL;
    try {
        url = new URL(mcpUrl);
    } catch {
        throw new Error(`${mcpUrl} is not a URL`);
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]' && url.hostname !== 'localhost') {
        throw new Error(`the Genie MCP server must be reached over loopback; ${url.hostname} is not loopback`);
    }
    return url;
}

/** The three variables — or NOTHING when there is no server yet. Never a fake or stale URL. */
export function takeOverEnv(endpoint: McpEndpoint | null): Record<string, string> {
    if (endpoint === null) return {};
    assertLoopback(endpoint.mcpUrl);
    if (!endpoint.token) throw new Error('an empty MCP token is an open server; refusing to hand one out');
    if (!endpoint.terminalId) throw new Error('a terminal id is required — it is how every tool call is attributed');
    return {
        GENIE_MCP_URL: endpoint.mcpUrl,
        GENIE_TERMINAL_ID: endpoint.terminalId,
        GENIE_MCP_TOKEN: endpoint.token,
    };
}

/** Claude Code's `.mcp.json` entry: the header references the variable; the value never appears. */
export function claudeMcpConfig(input: { mcpUrl: string }): { mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> } {
    assertLoopback(input.mcpUrl);
    return { mcpServers: { genie: { type: 'http', url: input.mcpUrl, headers: { Authorization: 'Bearer ${GENIE_MCP_TOKEN}' } } } };
}

/** Codex's `config.toml` block: `bearer_token_env_var` keeps the token out of the file entirely. */
export function codexMcpConfig(input: { mcpUrl: string }): string {
    assertLoopback(input.mcpUrl);
    return ['[mcp_servers.genie]', `url = "${input.mcpUrl}"`, 'bearer_token_env_var = "GENIE_MCP_TOKEN"', ''].join('\n');
}
