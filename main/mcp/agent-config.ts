import fs from 'fs';
import path from 'path';
import { GENIE_AGENTS_BRIEF } from './guide';
import { getAllSettings } from '../db';
import { upsertEnvLine } from '../env-file';
import { ensureEnvGitignored, loadWorkspaceEnvVars } from '../env-store';

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

/** The workspace `.env` key the Tynn project agent token is ALSO landed under.
 *  The `.mcp.json` entry embeds the token as a LITERAL now (see `tynnEntry`), so
 *  the config no longer depends on this — but we still write it (harmless, and
 *  other tooling / a human `${TYNN_AGENT_TOKEN}` reference may read it, and the
 *  offline self-heal re-embeds the literal FROM here). */
export const TYNN_TOKEN_ENV_KEY = 'TYNN_AGENT_TOKEN';

/**
 * The Tynn MCP server entry — an authenticated remote endpoint. The Authorization
 * header embeds the project agent token as a LITERAL (`Bearer <token>`) for BOTH
 * targets — NOT an `${TYNN_AGENT_TOKEN}` / `${env:TYNN_AGENT_TOKEN}` reference.
 *
 * Why a literal (this was a production outage — no agent could reach Tynn):
 * Claude Code and Cursor REFUSE to load ANY server entry whose referenced `${VAR}`
 * is unset in the client's OWN process env. `TYNN_AGENT_TOKEN` is only set inside a
 * fresh Genie terminal (Genie injects the workspace `.env` there), so an agent
 * launched anywhere else — a stale long-running terminal, a subagent, another
 * shell, a non-Genie shell — had the var UNSET, which made the whole `tynn` entry
 * fail to load → "can't connect to Tynn." This is the EXACT failure the `genie`
 * entry already fixed by baking a literal URL (see the file header comment). A
 * literal token makes the config self-contained, so it loads no matter who launches
 * the agent. Safe because `.mcp.json` AND `.cursor/mcp.json` are BOTH gitignored
 * (the provisioner enforces that), so the secret is never committed — this is what
 * older builds did before the (broken) env-reference form was introduced.
 */
export function tynnEntry(url: string, token: string, mode: 'claude' | 'cursor'): JsonObj {
    const base: JsonObj = mode === 'claude' ? { type: 'http', url } : { url };
    return { ...base, headers: { Authorization: `Bearer ${token}` } };
}

/**
 * ALSO land the Tynn token in the workspace `.env` (gitignored) under
 * `TYNN_AGENT_TOKEN`, preserving any other `.env` lines. The `.mcp.json` entry
 * now embeds the token as a literal (see `tynnEntry`), so the config no longer
 * DEPENDS on this — but we keep writing it because other tooling (or a human
 * `${TYNN_AGENT_TOKEN}` reference) may read it, and the offline self-heal
 * (`healTynnLiteralToken`) reads THIS to re-embed the literal for any workspace
 * still on the old broken `${…}` form — no re-mint. Best-effort.
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
 * True when the `tynn` server is already configured in the CURRENT, self-contained
 * form: the `.mcp.json` entry's Authorization embeds a REAL literal `Bearer <token>`
 * — NOT the old broken `${TYNN_AGENT_TOKEN}` env reference, and NOT an empty
 * `Bearer `.
 *
 * This is what "already configured" must mean for provisioning. The old build wrote
 * a `${…}` reference that the MCP client refuses to load when the var is unset (the
 * outage); returning FALSE for that form — and for an empty token — makes the
 * auto-provisioner RE-RUN and rewrite the entry to the literal form (via
 * `writeWorkspaceTynnMcp`), so a broken workspace self-heals on the next provision
 * instead of being skipped as "done".
 */
export function hasTynnLiteralToken(workspacePath: string): boolean {
    const file = path.join(workspacePath, '.mcp.json');
    const cfg = fs.existsSync(file) ? readJson(file) : null;
    const servers = cfg?.mcpServers as JsonObj | undefined;
    const tynn = servers?.[TYNN_SERVER_NAME] as JsonObj | undefined;
    const headers = tynn?.headers as JsonObj | undefined;
    const auth = headers?.Authorization;
    if (typeof auth !== 'string') return false;
    const m = /^Bearer\s+(.+)$/.exec(auth.trim());
    if (!m) return false;
    const token = m[1].trim();
    // A real literal token — non-empty and NOT an `${…}` env reference.
    return token.length > 0 && !token.includes('${');
}

/**
 * Write (or remove) the `tynn` MCP server in a workspace's Claude + Cursor
 * configs. Mirrors writeWorkspaceAgentMcp's per-target sync gating. The entry
 * embeds the project agent token as a LITERAL (self-contained — see `tynnEntry`),
 * so callers must ensure `.mcp.json` AND `.cursor/mcp.json` are gitignored (the
 * provisioner does — `ensureMcpGitignored`) so the secret never gets committed.
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
    // ALSO land the token in the gitignored `.env` (harmless — the configs below
    // embed the literal directly; the offline self-heal reads it back from here).
    if (enabled && opts?.token) {
        writeTynnTokenEnv(workspacePath, opts.token);
    }
    if (sync.claude) {
        const entry = enabled && opts ? tynnEntry(opts.url, opts.token, 'claude') : {};
        upsert(path.join(workspacePath, '.mcp.json'), TYNN_SERVER_NAME, entry, enabled);
    }
    if (sync.cursor) {
        const entry = enabled && opts ? tynnEntry(opts.url, opts.token, 'cursor') : {};
        upsert(path.join(workspacePath, '.cursor', 'mcp.json'), TYNN_SERVER_NAME, entry, enabled);
    }
}

/**
 * Self-heal a workspace stuck on the OLD, broken `${TYNN_AGENT_TOKEN}` reference
 * form: rewrite its `tynn` entry to the self-contained literal-token form, reading
 * the URL from the EXISTING entry and the token from the workspace's own gitignored
 * `.env` (where an earlier provision already landed it). NO re-mint and NO network —
 * a pure on-disk migration, so opening / app startup heals a workspace even offline.
 *
 * A no-op (returns false) when there's nothing to do: no `tynn` entry, it's ALREADY
 * in the literal form, the URL is missing, or the `.env` has no token to embed
 * (those workspaces heal via a real re-mint on the next `provisionWorkspaceTynn`).
 * Returns true only when it rewrote the config. Best-effort — callers gitignore.
 */
export function healTynnLiteralToken(workspacePath: string): boolean {
    if (!workspacePath) return false;
    if (hasTynnLiteralToken(workspacePath)) return false; // already self-contained
    const file = path.join(workspacePath, '.mcp.json');
    const cfg = fs.existsSync(file) ? readJson(file) : null;
    const servers = cfg?.mcpServers as JsonObj | undefined;
    const tynn = servers?.[TYNN_SERVER_NAME] as JsonObj | undefined;
    if (!tynn) return false; // no entry to heal
    const url = typeof tynn.url === 'string' ? tynn.url : '';
    if (!url) return false;
    // The token lives in the workspace's own `.env` (an earlier provision put it
    // there); without it we can't embed a literal — leave it for a real re-mint.
    const token = loadWorkspaceEnvVars(workspacePath)[TYNN_TOKEN_ENV_KEY];
    if (!token) return false;
    writeWorkspaceTynnMcp(workspacePath, true, { url, token });
    return true;
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
