import fs from 'fs';
import path from 'path';

/**
 * Write/remove the Genie MCP server entry in a workspace's agent config files
 * when its Agent MCP is toggled, so Claude Code and Cursor auto-discover it.
 *
 *   Claude Code → <workspace>/.mcp.json
 *   Cursor      → <workspace>/.cursor/mcp.json
 *
 * The url is the literal `${GENIE_MCP_URL}`, NOT a baked-in address: the MCP
 * server binds an ephemeral port each launch, and every terminal gets its OWN
 * endpoint token (so `imDone` resolves the caller). Genie injects the full
 * per-terminal URL as GENIE_MCP_URL into each terminal's env; both Claude Code
 * and Cursor expand `${VAR}` in mcp.json at agent start, so each terminal's
 * agent connects to its own endpoint. (It therefore only resolves inside a
 * Genie terminal — agents launched outside one won't have GENIE_MCP_URL.)
 *
 * Merges into existing config (never clobbers other servers); on disable it
 * removes only the `genie` key.
 */

export const GENIE_SERVER_NAME = 'genie';
const URL_REF = '${GENIE_MCP_URL}';

/** Claude Code uses an explicit transport `type`; Cursor infers from `url`. */
const CLAUDE_ENTRY = { type: 'http', url: URL_REF };
const CURSOR_ENTRY = { url: URL_REF };

type JsonObj = Record<string, unknown>;

/**
 * Pure: apply (or remove) the genie server entry to a parsed config object.
 * Returns the next config, or null when there's nothing to write (disabling a
 * config that never had a genie entry — so we don't create files just to omit).
 */
export function applyGenieServer(
    existing: JsonObj | null,
    entry: JsonObj,
    enabled: boolean,
): JsonObj | null {
    const base: JsonObj = existing ? { ...existing } : {};
    const servers: JsonObj =
        base.mcpServers && typeof base.mcpServers === 'object'
            ? { ...(base.mcpServers as JsonObj) }
            : {};
    if (enabled) {
        servers[GENIE_SERVER_NAME] = entry;
    } else {
        if (!(GENIE_SERVER_NAME in servers) && existing === null) return null;
        delete servers[GENIE_SERVER_NAME];
    }
    base.mcpServers = servers;
    return base;
}

function readJson(file: string): JsonObj | null {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObj;
    } catch {
        return null;
    }
}

function upsert(file: string, entry: JsonObj, enabled: boolean): void {
    const existing = fs.existsSync(file) ? readJson(file) : null;
    const next = applyGenieServer(existing, entry, enabled);
    if (next === null) return; // nothing to remove and no file to touch
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
    } catch {
        /* best-effort — a read-only/locked file shouldn't break the toggle */
    }
}

/** Write or remove the genie entry in a workspace's Claude + Cursor MCP configs. */
export function writeWorkspaceAgentMcp(workspacePath: string, enabled: boolean): void {
    if (!workspacePath) return;
    upsert(path.join(workspacePath, '.mcp.json'), CLAUDE_ENTRY, enabled);
    upsert(path.join(workspacePath, '.cursor', 'mcp.json'), CURSOR_ENTRY, enabled);
}
