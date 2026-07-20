import fs from 'fs';
import path from 'path';
import { GENIE_AGENTS_BRIEF } from './guide';
import { getAllSettings } from '../db';
import { upsertEnvLine } from '../env-file';
import { ensureEnvGitignored, loadWorkspaceEnvVars } from '../env-store';
import { pluginAgentSkills, type PluginSkill } from '../plugins/registry';

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

/** Read the provisioned Tynn MCP URL from the workspace's Claude config. The
 * token itself is not needed for Codex: Genie loads the workspace `.env` into
 * agent terminals and Codex supports `bearer_token_env_var`. */
export function readTynnMcpUrl(workspacePath: string): string | null {
    const file = path.join(workspacePath, '.mcp.json');
    const cfg = fs.existsSync(file) ? readJson(file) : null;
    const servers = cfg?.mcpServers as JsonObj | undefined;
    const tynn = servers?.[TYNN_SERVER_NAME] as JsonObj | undefined;
    const url = tynn?.url;
    return typeof url === 'string' && url.trim() ? url : null;
}

/**
 * Read the literal bearer token from the provisioned Tynn MCP entry. Codex uses
 * `bearer_token_env_var`, so every terminal spawn must be able to reconstruct
 * that environment even when the workspace `.env` is absent or stale.
 */
export function readTynnMcpBearerToken(workspacePath: string): string | null {
    const file = path.join(workspacePath, '.mcp.json');
    const cfg = fs.existsSync(file) ? readJson(file) : null;
    const servers = cfg?.mcpServers as JsonObj | undefined;
    const tynn = servers?.[TYNN_SERVER_NAME] as JsonObj | undefined;
    const headers = tynn?.headers as JsonObj | undefined;
    const authorization = headers?.Authorization;
    if (typeof authorization !== 'string') return null;
    const match = /^Bearer\s+(.+)$/.exec(authorization.trim());
    if (!match || match[1].includes('${')) return null;
    return match[1].trim() || null;
}

/** Workspace env for terminal creation, healed from the authoritative MCP config. */
export function loadWorkspaceTerminalEnv(workspacePath: string): Record<string, string> {
    const env = loadWorkspaceEnvVars(workspacePath);
    const token = readTynnMcpBearerToken(workspacePath);
    return token ? { ...env, [TYNN_TOKEN_ENV_KEY]: token } : env;
}

export function syncWorkspaceCodexTynnMcp(workspacePath: string): boolean {
    const url = readTynnMcpUrl(workspacePath);
    const token = readTynnMcpBearerToken(workspacePath);
    if (!url || !token) return false;
    let enabled = true;
    try {
        enabled = getAllSettings().mcp_sync_codex !== 'off';
    } catch {
        /* default on */
    }
    if (!enabled) return false;
    writeTynnTokenEnv(workspacePath, token);
    syncCodexServer(workspacePath, TYNN_SERVER_NAME, url, TYNN_TOKEN_ENV_KEY, true);
    return true;
}

/**
 * Quote a value as a single-quoted TOML literal for Codex's `-c key=value`
 * override. Single quotes are shell-portable inside the outer `"..."` (a literal
 * char in bash/pwsh/cmd). TOML literal strings have NO escape for a single quote,
 * and our values are URLs / an env-var name that never legitimately contain one —
 * so any stray `'` is percent-encoded (`%27`, its correct URL form) to keep the
 * output valid TOML instead of silently malformed (`''` is not a TOML escape).
 */
function tomlLiteral(value: string): string {
    return `'${value.replace(/'/g, '%27')}'`;
}

export function applyCodexServerBlock(
    existing: string,
    name: string,
    url: string,
    bearerTokenEnvVar: string | null,
    enabled: boolean,
): string {
    const begin = `# BEGIN GENIE MCP: ${name}`;
    const end = `# END GENIE MCP: ${name}`;
    const escapedBegin = begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const without = existing.replace(
        new RegExp(`${escapedBegin}\\r?\\n[\\s\\S]*?${escapedEnd}(?:\\r?\\n)?`, 'g'),
        '',
    );
    if (!enabled || !url) return without;
    const block = [
        begin,
        `[mcp_servers.${name}]`,
        `url = ${tomlLiteral(url)}`,
        ...(bearerTokenEnvVar
            ? [`bearer_token_env_var = ${tomlLiteral(bearerTokenEnvVar)}`]
            : []),
        end,
        '',
    ].join('\n');
    return `${without}${without && !without.endsWith('\n') ? '\n' : ''}${block}`;
}

function syncCodexServer(
    workspacePath: string,
    name: string,
    url: string,
    bearerTokenEnvVar: string | null,
    enabled: boolean,
): void {
    ensureCodexConfigGitignored(workspacePath);
    const file = path.join(workspacePath, '.codex', 'config.toml');
    let existing = '';
    try {
        existing = fs.readFileSync(file, 'utf8');
    } catch {
        /* absent — created below */
    }
    const next = applyCodexServerBlock(existing, name, url, bearerTokenEnvVar, enabled);
    if (next === existing) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, next);
    } catch {
        /* best-effort — launch-time overrides remain the fallback */
    }
}

function ensureCodexConfigGitignored(workspacePath: string): void {
    const file = path.join(workspacePath, '.gitignore');
    const rule = '.codex/config.toml';
    try {
        let existing = '';
        try {
            existing = fs.readFileSync(file, 'utf8');
        } catch {
            /* absent — created below */
        }
        if (existing.split(/\r?\n/).map((line) => line.trim()).includes(rule)) return;
        const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
        fs.writeFileSync(
            file,
            `${existing}${prefix}\n# Genie: machine-local Codex MCP endpoints\n${rule}\n`,
        );
    } catch {
        /* best-effort */
    }
}

/**
 * Launch-time overrides remain a compatibility fallback for Codex versions
 * predating project `.codex/config.toml`, and for commands launched before the
 * workspace sync completes.
 */
export function codexMcpLaunchArgs(input: {
    genieUrl?: string | null;
    tynnUrl?: string | null;
}): string {
    const args: string[] = [];
    if (input.genieUrl) {
        args.push(`-c "mcp_servers.${GENIE_SERVER_NAME}.url=${tomlLiteral(input.genieUrl)}"`);
    }
    if (input.tynnUrl) {
        args.push(`-c "mcp_servers.${TYNN_SERVER_NAME}.url=${tomlLiteral(input.tynnUrl)}"`);
        args.push(
            `-c "mcp_servers.${TYNN_SERVER_NAME}.bearer_token_env_var=${tomlLiteral(TYNN_TOKEN_ENV_KEY)}"`,
        );
    }
    return args.join(' ');
}

export function applyCodexMcpLaunchArgs(
    command: string,
    input: { genieUrl?: string | null; tynnUrl?: string | null },
): string {
    const args = codexMcpLaunchArgs(input);
    return args ? `${command.trim()} ${args}`.trim() : command;
}

/**
 * The launch-command gate for Codex MCP wiring: ONLY a Codex terminal, and ONLY
 * when `mcp_sync_codex` is on, gets the project-scoped `-c` overrides appended;
 * every other agent — and Codex with the sync off — is returned unchanged. Pure
 * (host-tools resolves the URLs + settings and passes them in) so the gating is
 * testable without host-tools' dependency graph.
 */
export function withCodexMcpLaunch(
    command: string,
    input: {
        agent: string;
        mcpSyncCodexOff: boolean;
        genieUrl?: string | null;
        tynnUrl?: string | null;
    },
): string {
    if (input.agent !== 'codex' || input.mcpSyncCodexOff) return command;
    return applyCodexMcpLaunchArgs(command, { genieUrl: input.genieUrl, tynnUrl: input.tynnUrl });
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

/**
 * Make the workspace's project `.mcp.json` MCP servers AVAILABLE to a launched
 * Claude Code agent (genie #10). Claude Code does NOT auto-enable project-scoped
 * `.mcp.json` servers: on launch they sit DISABLED pending an interactive
 * approval prompt, and `--dangerously-skip-permissions` does not cover that
 * approval. A non-interactive Genie agent terminal never gets to approve, so it
 * boots with the `genie`/`tynn` servers present-but-unavailable — the agent looks
 * healthy but is toolless. Setting `enableAllProjectMcpServers` in the workspace's
 * `.claude/settings.local.json` auto-approves the project config so the servers
 * come up on launch. Written to the LOCAL settings (per-machine, gitignored)
 * because the `.mcp.json` it enables is itself per-machine (provisioned +
 * gitignored, never committed) and Genie-authored, so auto-approving it is not a
 * trust escalation. Idempotent + best-effort — a locked file must never break
 * provisioning, and existing keys in the file are preserved.
 */
export function ensureClaudeProjectMcpEnabled(workspacePath: string): void {
    if (!workspacePath) return;
    const file = path.join(workspacePath, '.claude', 'settings.local.json');
    const existing = (fs.existsSync(file) ? readJson(file) : null) ?? {};
    if (existing.enableAllProjectMcpServers === true) return; // already enabled
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
            file,
            JSON.stringify({ ...existing, enableAllProjectMcpServers: true }, null, 2) + '\n',
        );
    } catch {
        /* best-effort — a read-only/locked settings file must not break provisioning */
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
    let sync = { claude: true, cursor: true, codex: true };
    try {
        const s = getAllSettings();
        sync = {
            claude: s.mcp_sync_claude !== 'off',
            cursor: s.mcp_sync_cursor !== 'off',
            codex: s.mcp_sync_codex !== 'off',
        };
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
        // Auto-approve project MCP servers so the launched Claude agent actually
        // has the tynn server available on boot, not present-but-disabled (genie #10).
        if (enabled) ensureClaudeProjectMcpEnabled(workspacePath);
    }
    if (sync.cursor) {
        const entry = enabled && opts ? tynnEntry(opts.url, opts.token, 'cursor') : {};
        upsert(path.join(workspacePath, '.cursor', 'mcp.json'), TYNN_SERVER_NAME, entry, enabled);
    }
    if (sync.codex) {
        syncCodexServer(
            workspacePath,
            TYNN_SERVER_NAME,
            opts?.url ?? '',
            TYNN_TOKEN_ENV_KEY,
            enabled,
        );
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
 * Where each agent looks for repo-scoped skills. Codex reads `.agents/skills`,
 * Claude Code reads `.claude/skills`; the SKILL.md format (YAML frontmatter +
 * markdown body) is the same for both, so one body serves both roots.
 */
const SKILL_ROOTS: Record<'codex' | 'claude', string[]> = {
    codex: ['.agents', 'skills'],
    claude: ['.claude', 'skills'],
};

/**
 * Prefix for the plugin skills Genie MANAGES. Everything under a skills root
 * matching `genie-plugin-*` is Genie's to create, rewrite, and prune; anything
 * else in that directory is the user's and is never touched. Without this marker
 * pruning a removed plugin couldn't tell a Genie-written skill from a hand-authored
 * one.
 */
const PLUGIN_SKILL_PREFIX = 'genie-plugin-';

/** The repo-scoped Genie skill installed with Genie's MCP registration. */
export function genieCodexSkill(): string {
    return `---
name: genie
description: Use whenever working inside Genie or when Genie MCP tools are available. Orients fresh .agi workspaces and routes completion, user questions, terminals, processes, workspaces, IssueWatch, and agent coordination through Genie.
---

# Genie workspace workflow

1. In a fresh or newly converted workspace, call \`initializeWorkspace\` and follow its repository-orientation plan.
2. Use the Genie tools for UI-visible coordination:
   - \`imDone\` whenever handing work back.
   - \`ForceTheQuestion\` when only the user can unblock a decision.
   - \`manageTerminals\` and \`runAgent\` for terminals or coding agents.
   - \`manageProcess\` for supervised long-running processes, subject to workspace instructions.
   - \`checkIssues\` for the current IssueWatch feed.
3. Pass \`GENIE_TERMINAL_ID\` as \`terminalId\` when available so actions target this exact terminal.
4. Call \`genieGuide\` before using an unfamiliar Genie capability or when you need the complete safety and routing rules.

Always follow the workspace's AGENTS.md; it may impose stronger project-specific rules.
`;
}

/** Render a plugin's guidance as a SKILL.md. */
export function pluginSkillBody(skill: PluginSkill): string {
    const tools = skill.tools.map((t) => `- \`${t.name}\` — ${t.description}`).join('\n');
    // The description drives WHEN an agent loads this skill, so it names the
    // plugin, its purpose, and its tools rather than restating the guide.
    const description =
        `Use when working with ${skill.name} or its Genie tools ` +
        `(${skill.tools.map((t) => t.name).join(', ')}). ${skill.description}`;
    return `---
name: ${PLUGIN_SKILL_PREFIX}${skill.namespace}
description: ${description.replace(/\s+/g, ' ').trim()}
---

# ${skill.name}

${skill.guide}

## Tools

${tools}

These tools are contributed by the ${skill.name} Genie plugin and are only
available while it stays enabled in this workspace.
`;
}

/** Write `file` only when its content would change (keeps mtimes stable). */
function writeIfChanged(file: string, body: string): void {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

/**
 * Sync the repo-scoped skills for ONE agent: Genie's own workflow skill plus a
 * skill per enabled plugin that declares `agent.guide`.
 *
 * Removal is deliberately asymmetric. The Genie skill is only deleted when it
 * still matches exactly what we wrote (a user edit is theirs to keep), while
 * plugin skills under the `genie-plugin-` prefix are fully managed — a plugin
 * that's been disabled or uninstalled must not leave an agent believing tools
 * exist that no longer resolve.
 */
function syncAgentSkills(
    workspacePath: string,
    agent: 'codex' | 'claude',
    enabled: boolean,
): void {
    try {
        const root = path.join(workspacePath, ...SKILL_ROOTS[agent]);
        const genieFile = path.join(root, 'genie', 'SKILL.md');
        const skills = enabled ? pluginAgentSkills() : [];
        const wanted = new Map(
            skills.map((s) => [`${PLUGIN_SKILL_PREFIX}${s.namespace}`, pluginSkillBody(s)]),
        );

        if (!enabled) {
            if (fs.existsSync(genieFile) && fs.readFileSync(genieFile, 'utf8') === genieCodexSkill()) {
                fs.rmSync(genieFile);
            }
        } else {
            writeIfChanged(genieFile, genieCodexSkill());
            for (const [name, body] of wanted) {
                writeIfChanged(path.join(root, name, 'SKILL.md'), body);
            }
        }

        // Prune managed plugin skills that are no longer wanted.
        if (!fs.existsSync(root)) return;
        for (const entry of fs.readdirSync(root)) {
            if (!entry.startsWith(PLUGIN_SKILL_PREFIX) || wanted.has(entry)) continue;
            fs.rmSync(path.join(root, entry), { recursive: true, force: true });
        }
    } catch {
        /* best-effort — MCP registration must still proceed */
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
    let sync = { claude: true, cursor: true, codex: true, agents: true };
    try {
        const s = getAllSettings();
        sync = {
            claude: s.mcp_sync_claude !== 'off',
            cursor: s.mcp_sync_cursor !== 'off',
            codex: s.mcp_sync_codex !== 'off',
            agents: s.mcp_sync_agents !== 'off',
        };
    } catch {
        /* best-effort — default to syncing all if settings can't be read */
    }
    // Auto-approve the workspace's project MCP servers for a launched Claude agent
    // (genie #10) whenever the workspace is MCP-enabled and we sync Claude —
    // independent of whether the endpoint resolved right now, since the tynn server
    // (and a later genie re-sync) still need to come up available.
    if (enabled && sync.claude) ensureClaudeProjectMcpEnabled(workspacePath);
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
        if (sync.codex) syncCodexServer(workspacePath, GENIE_SERVER_NAME, '', null, false);
        // Skills stay in sync even with the endpoint down — the workspace is still
        // MCP-enabled, so the guidance is still correct; only the URL is missing.
        if (sync.codex) syncAgentSkills(workspacePath, 'codex', true);
        if (sync.claude) syncAgentSkills(workspacePath, 'claude', true);
        if (sync.agents) syncAgentsMd(workspacePath, true);
        return;
    }
    if (sync.claude) {
        upsert(path.join(workspacePath, '.mcp.json'), GENIE_SERVER_NAME, claudeEntry(url ?? ''), enabled);
        syncAgentSkills(workspacePath, 'claude', enabled);
    }
    if (sync.cursor) {
        upsert(
            path.join(workspacePath, '.cursor', 'mcp.json'),
            GENIE_SERVER_NAME,
            cursorEntry(url ?? ''),
            enabled,
        );
    }
    if (sync.codex) {
        syncCodexServer(workspacePath, GENIE_SERVER_NAME, url ?? '', null, enabled);
        syncAgentSkills(workspacePath, 'codex', enabled);
    }
    if (sync.agents) syncAgentsMd(workspacePath, enabled);
}
