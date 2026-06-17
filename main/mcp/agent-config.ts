import fs from 'fs';
import path from 'path';
import { GENIE_AGENTS_BRIEF } from './guide';
import { getAllSettings } from '../db';

/**
 * Write/remove the Genie MCP server entry in a workspace's agent config files
 * when its Agent MCP is toggled, so Claude Code and Cursor auto-discover it.
 *
 *   Claude Code → <workspace>/.mcp.json
 *   Cursor      → <workspace>/.cursor/mcp.json
 *
 * The url is a HARD-CODED literal — `http://127.0.0.1:<port>/mcp/<token>` — NOT
 * an `${ENV}` reference. The server now binds a FIXED, user-settable port, and
 * each workspace gets one stable endpoint token, so the URL is stable and needs
 * no env-var expansion. (The old `${GENIE_MCP_URL}` ref was the connection bug:
 * Claude Code refuses to parse a config whose referenced var is unset — so an
 * agent launched outside a Genie terminal broke ALL its MCP servers — and
 * Cursor uses a different `${env:NAME}` syntax entirely, so it never resolved
 * there. A literal URL just works in both.) Per-terminal resolution for
 * imDone/ForceTheQuestion is preserved server-side via the tools' optional
 * `terminalId` arg (read from GENIE_TERMINAL_ID) with a last-active fallback.
 *
 * Merges into existing config (never clobbers other servers); on disable it
 * removes only the `genie` key.
 */

export const GENIE_SERVER_NAME = 'genie';

type JsonObj = Record<string, unknown>;

/** Claude Code uses an explicit transport `type`; Cursor infers from `url`. */
export function claudeEntry(url: string): JsonObj {
    return { type: 'http', url };
}
export function cursorEntry(url: string): JsonObj {
    return { url };
}

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

// --- AGENTS.md brief --------------------------------------------------------
//
// Beyond the machine-readable mcp.json, we keep a short human/agent-readable
// note in the workspace's AGENTS.md so agents reading it know the genie MCP
// exists and where to get the full guide. Marker-delimited so it's updated in
// place (never duplicated) and cleanly removable on disable.

const AGENTS_BEGIN = '<!-- BEGIN GENIE MCP (auto-managed by Genie) -->';
const AGENTS_END = '<!-- END GENIE MCP (auto-managed by Genie) -->';

/**
 * Pure: produce the next AGENTS.md content given the existing content.
 *   - enabled: insert the genie block, or replace it in place if already present
 *     (appended to the end when absent).
 *   - disabled: strip the block if present.
 * Returns the next string, or the input unchanged when there's nothing to do.
 */
export function applyAgentsSection(existing: string, enabled: boolean): string {
    const block = `${AGENTS_BEGIN}\n## Genie MCP\n\n${GENIE_AGENTS_BRIEF}\n${AGENTS_END}`;
    const begin = existing.indexOf(AGENTS_BEGIN);
    const end = existing.indexOf(AGENTS_END);
    const hasBlock = begin !== -1 && end !== -1 && end > begin;

    if (enabled) {
        if (hasBlock) {
            const before = existing.slice(0, begin);
            const after = existing.slice(end + AGENTS_END.length);
            return before + block + after;
        }
        const sep = existing.length === 0 || existing.endsWith('\n\n')
            ? ''
            : existing.endsWith('\n')
              ? '\n'
              : '\n\n';
        return existing + sep + block + '\n';
    }
    // disabled: remove the block (and a trailing blank line it leaves behind).
    if (!hasBlock) return existing;
    const before = existing.slice(0, begin).replace(/\n+$/, '\n');
    const after = existing.slice(end + AGENTS_END.length).replace(/^\n+/, '');
    return (before + after).replace(/\n{3,}$/, '\n');
}

/**
 * Sync the genie brief into a workspace's AGENTS.md. Only touches a file that
 * ALREADY EXISTS — we don't litter AGENTS.md into projects that don't use one.
 * Idempotent: re-running with the same state is a no-op write.
 */
function syncAgentsMd(workspacePath: string, enabled: boolean): void {
    const file = path.join(workspacePath, 'AGENTS.md');
    let existing: string;
    try {
        existing = fs.readFileSync(file, 'utf8');
    } catch {
        return; // no AGENTS.md → nothing to update
    }
    const next = applyAgentsSection(existing, enabled);
    if (next === existing) return;
    try {
        fs.writeFileSync(file, next);
    } catch {
        /* best-effort */
    }
}

/**
 * Write or remove the genie entry in a workspace's Claude + Cursor MCP configs.
 * `url` is the workspace's stable endpoint (`http://127.0.0.1:<port>/mcp/<tok>`);
 * it's required when enabling. On disable the url is ignored (the entry is just
 * removed), so callers may pass null there.
 *
 * Each target is gated by a per-target sync setting (default on): Claude
 * (`mcp_sync_claude`), Cursor (`mcp_sync_cursor`), AGENTS.md (`mcp_sync_agents`).
 * A target that's OFF is left ENTIRELY ALONE — Genie neither writes nor removes
 * its file — so a user's manual deletion sticks and a Cursor non-user isn't
 * forced a `.cursor/mcp.json`.
 */
export function writeWorkspaceAgentMcp(
    workspacePath: string,
    enabled: boolean,
    url: string | null,
): void {
    if (!workspacePath) return;
    let sync = { claude: true, cursor: true, agents: true };
    try {
        const s = getAllSettings();
        sync = {
            claude: s.mcp_sync_claude !== 'off',
            cursor: s.mcp_sync_cursor !== 'off',
            agents: s.mcp_sync_agents !== 'off',
        };
    } catch {
        /* best-effort — default to syncing all if settings can't be read */
    }
    // Enabling without a resolved URL (server not listening yet) would write a
    // broken entry — skip the config writes but still keep AGENTS.md in sync.
    if (enabled && !url) {
        if (sync.agents) syncAgentsMd(workspacePath, true);
        return;
    }
    if (sync.claude) {
        upsert(path.join(workspacePath, '.mcp.json'), claudeEntry(url ?? ''), enabled);
    }
    if (sync.cursor) {
        upsert(
            path.join(workspacePath, '.cursor', 'mcp.json'),
            cursorEntry(url ?? ''),
            enabled,
        );
    }
    if (sync.agents) syncAgentsMd(workspacePath, enabled);
}
