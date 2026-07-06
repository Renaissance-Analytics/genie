import fs from 'fs';
import path from 'path';
import { GENIE_AGENTS_BRIEF } from './guide';
import { getAllSettings } from '../db';
import { upsertEnvLine } from '../env-file';
import { ensureEnvGitignored } from '../env-store';

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
export const TYNN_SERVER_NAME = 'tynn';

type JsonObj = Record<string, unknown>;

/** Claude Code uses an explicit transport `type`; Cursor infers from `url`. */
export function claudeEntry(url: string): JsonObj {
    return { type: 'http', url };
}
export function cursorEntry(url: string): JsonObj {
    return { url };
}

/** The workspace `.env` key the Tynn project agent token now lives under — the
 *  `.mcp.json` entry only REFERENCES it, so the secret never sits in the config
 *  (which Claude Code reads but the AGI envelope protocol moves to `.env`). */
export const TYNN_TOKEN_ENV_KEY = 'TYNN_AGENT_TOKEN';

/**
 * The Tynn MCP server entry — an authenticated remote endpoint. The project
 * agent token is NO LONGER embedded; the Authorization header REFERENCES the
 * `${TYNN_AGENT_TOKEN}` env var (the secret lives in the gitignored workspace
 * `.env`, which Genie loads into the agent's terminal).
 *
 * Per-target ref syntax:
 *   - Claude (`.mcp.json`): `${TYNN_AGENT_TOKEN:-}` — the `:-` default keeps an
 *     UNSET var from breaking the WHOLE config (the documented failure mode) when
 *     an agent is launched OUTSIDE a Genie terminal; it just sends an empty token
 *     (that one server fails auth) instead of poisoning every MCP server.
 *   - Cursor (`.cursor/mcp.json`): `${env:TYNN_AGENT_TOKEN}` (Cursor's syntax).
 */
export function tynnEntry(url: string, mode: 'claude' | 'cursor'): JsonObj {
    const auth =
        mode === 'cursor'
            ? `Bearer \${env:${TYNN_TOKEN_ENV_KEY}}`
            : `Bearer \${${TYNN_TOKEN_ENV_KEY}:-}`;
    const base: JsonObj = mode === 'claude' ? { type: 'http', url } : { url };
    return { ...base, headers: { Authorization: auth } };
}

/**
 * Move the Tynn token to the workspace `.env` (gitignored) under
 * `TYNN_AGENT_TOKEN`, preserving any other `.env` lines. This is also the
 * MIGRATION: re-writing a workspace's tynn config drops the literal token that
 * older builds embedded in `.mcp.json` (the entry is rewritten to the ref) and
 * lands the (freshly-minted) token here instead. Best-effort.
 */
function writeTynnTokenEnv(workspacePath: string, token: string): void {
    const file = path.join(workspacePath, '.env');
    let content = '';
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch {
        /* no .env yet — created below */
    }
    try {
        fs.writeFileSync(file, upsertEnvLine(content, TYNN_TOKEN_ENV_KEY, token));
        ensureEnvGitignored(workspacePath);
    } catch {
        /* best-effort — a locked .env shouldn't break provisioning */
    }
}

/**
 * Pure: apply (or remove) a named MCP server entry to a parsed config object.
 * Returns the next config, or null when there's nothing to write (disabling a
 * config that never had the entry — so we don't create files just to omit).
 */
export function applyServer(
    existing: JsonObj | null,
    name: string,
    entry: JsonObj,
    enabled: boolean,
): JsonObj | null {
    const base: JsonObj = existing ? { ...existing } : {};
    const servers: JsonObj =
        base.mcpServers && typeof base.mcpServers === 'object'
            ? { ...(base.mcpServers as JsonObj) }
            : {};
    if (enabled) {
        servers[name] = entry;
    } else {
        if (!(name in servers) && existing === null) return null;
        delete servers[name];
    }
    base.mcpServers = servers;
    return base;
}

/** Back-compat wrapper — the genie entry is just a named server. */
export function applyGenieServer(
    existing: JsonObj | null,
    entry: JsonObj,
    enabled: boolean,
): JsonObj | null {
    return applyServer(existing, GENIE_SERVER_NAME, entry, enabled);
}

function readJson(file: string): JsonObj | null {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObj;
    } catch {
        return null;
    }
}

function upsert(file: string, name: string, entry: JsonObj, enabled: boolean): void {
    const existing = fs.existsSync(file) ? readJson(file) : null;
    const next = applyServer(existing, name, entry, enabled);
    if (next === null) return; // nothing to remove and no file to touch
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
    } catch {
        /* best-effort — a read-only/locked file shouldn't break the toggle */
    }
}

/** True when a workspace's `.mcp.json` already has a `tynn` server entry. */
export function hasTynnServer(workspacePath: string): boolean {
    const file = path.join(workspacePath, '.mcp.json');
    const cfg = fs.existsSync(file) ? readJson(file) : null;
    const servers = cfg?.mcpServers;
    return !!servers && typeof servers === 'object' && TYNN_SERVER_NAME in (servers as JsonObj);
}

/**
 * True when the `tynn` server is configured in the CURRENT form: the `.mcp.json`
 * entry's Authorization REFERENCES `${TYNN_AGENT_TOKEN}` (not an embedded literal
 * token) AND that token is actually present in the gitignored workspace `.env`.
 *
 * This is what "already configured" must mean for provisioning — an OLD build
 * embedded the literal token in `.mcp.json`, so `hasTynnServer` alone reports
 * such a workspace as done and the auto-provisioner skips it, never migrating it
 * to `.env` (and never refreshing a stale token). Returning false for the literal
 * form — or for a reference whose `.env` token is missing — makes the provisioner
 * re-run, which migrates it via `writeWorkspaceTynnMcp`.
 */
export function hasTynnEnvReference(workspacePath: string): boolean {
    const file = path.join(workspacePath, '.mcp.json');
    const cfg = fs.existsSync(file) ? readJson(file) : null;
    const servers = cfg?.mcpServers as JsonObj | undefined;
    const tynn = servers?.[TYNN_SERVER_NAME] as JsonObj | undefined;
    const headers = tynn?.headers as JsonObj | undefined;
    const auth = headers?.Authorization;
    // The entry must reference the env var, not embed a literal token.
    if (typeof auth !== 'string' || !auth.includes(`\${${TYNN_TOKEN_ENV_KEY}`)) {
        return false;
    }
    // And the token must actually be in `.env` (else the reference resolves empty).
    try {
        const env = fs.readFileSync(path.join(workspacePath, '.env'), 'utf8');
        return new RegExp(`^\\s*${TYNN_TOKEN_ENV_KEY}=\\S`, 'm').test(env);
    } catch {
        return false;
    }
}

/**
 * Write (or remove) the `tynn` MCP server in a workspace's Claude + Cursor
 * configs. Mirrors writeWorkspaceAgentMcp's per-target sync gating. The entry
 * carries the project agent token — callers must ensure `.mcp.json` is
 * gitignored (the provisioner does) so the secret never gets committed.
 */
export function writeWorkspaceTynnMcp(
    workspacePath: string,
    enabled: boolean,
    opts: { url: string; token: string } | null,
): void {
    if (!workspacePath) return;
    if (enabled && (!opts?.url || !opts?.token)) return; // never write a broken/empty entry
    let sync = { claude: true, cursor: true };
    try {
        const s = getAllSettings();
        sync = { claude: s.mcp_sync_claude !== 'off', cursor: s.mcp_sync_cursor !== 'off' };
    } catch {
        /* default to syncing if settings can't be read */
    }
    // Land the secret in the gitignored `.env` (also migrates an older literal
    // token out of `.mcp.json`); the configs below only REFERENCE it.
    if (enabled && opts?.token) {
        writeTynnTokenEnv(workspacePath, opts.token);
    }
    if (sync.claude) {
        const entry = enabled && opts ? tynnEntry(opts.url, 'claude') : {};
        upsert(path.join(workspacePath, '.mcp.json'), TYNN_SERVER_NAME, entry, enabled);
    }
    if (sync.cursor) {
        const entry = enabled && opts ? tynnEntry(opts.url, 'cursor') : {};
        upsert(path.join(workspacePath, '.cursor', 'mcp.json'), TYNN_SERVER_NAME, entry, enabled);
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

/** True when `content` carries the auto-managed Genie MCP block (both markers). */
export function hasGenieAgentsSection(content: string): boolean {
    const begin = content.indexOf(AGENTS_BEGIN);
    const end = content.indexOf(AGENTS_END);
    return begin !== -1 && end !== -1 && end > begin;
}

/**
 * Pure: produce the next AGENTS.md content given the existing content.
 *   - enabled: insert the genie block, or replace it in place if already present
 *     (appended to the end when absent).
 *   - disabled: strip the block if present.
 * Returns the next string, or the input unchanged when there's nothing to do.
 *
 * `aiSystem` is the user's Ai.System instruction set (Settings → Customization).
 * When non-empty it's appended as a labeled subsection INSIDE the marker block,
 * after the Genie brief — so it's replaced in place on every sync (never
 * duplicated) and removed cleanly on disable. Empty (the default) keeps the
 * block byte-identical to the brief-only form, so existing callers/tests that
 * omit it are unaffected.
 */
export function applyAgentsSection(existing: string, enabled: boolean, aiSystem = ''): string {
    const trimmed = aiSystem.trim();
    const aiSection = trimmed
        ? `\n\n### Ai.System — workspace instructions (set in Genie → Settings → Customization)\n\n${trimmed}`
        : '';
    const block = `${AGENTS_BEGIN}\n## GENIE PROTOCOL\n\n${GENIE_AGENTS_BRIEF}${aiSection}\n${AGENTS_END}`;
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
    // The user's Ai.System instruction set, injected into the block below.
    // Best-effort: a settings-read failure must not break the AGENTS.md sync.
    let aiSystem = '';
    try {
        aiSystem = (getAllSettings().ai_system as string) ?? '';
    } catch {
        /* leave empty — sync proceeds with the brief-only block */
    }
    const next = applyAgentsSection(existing, enabled, aiSystem);
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
    // Enabling without a resolved URL (the server isn't listening / a stale box
    // can't resolve the endpoint). Writing the entry would be a broken stub, and
    // LEAVING a previously-written one makes the agent's client fail to connect
    // (a type-less / dead `genie` entry → "command expected"). So REMOVE any
    // existing genie entry from the configs — but keep AGENTS.md in sync, since
    // the workspace is still MCP-enabled; only the endpoint is down right now.
    if (enabled && !url) {
        if (sync.claude) {
            upsert(path.join(workspacePath, '.mcp.json'), GENIE_SERVER_NAME, claudeEntry(''), false);
        }
        if (sync.cursor) {
            upsert(
                path.join(workspacePath, '.cursor', 'mcp.json'),
                GENIE_SERVER_NAME,
                cursorEntry(''),
                false,
            );
        }
        if (sync.agents) syncAgentsMd(workspacePath, true);
        return;
    }
    if (sync.claude) {
        upsert(path.join(workspacePath, '.mcp.json'), GENIE_SERVER_NAME, claudeEntry(url ?? ''), enabled);
    }
    if (sync.cursor) {
        upsert(
            path.join(workspacePath, '.cursor', 'mcp.json'),
            GENIE_SERVER_NAME,
            cursorEntry(url ?? ''),
            enabled,
        );
    }
    if (sync.agents) syncAgentsMd(workspacePath, enabled);
}
