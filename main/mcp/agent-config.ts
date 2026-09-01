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
export const AGENTINBOX_CLAUDE_CHANNEL_NAME = 'genie-agentinbox-channel';
const CODEX_SESSION_HOOK_BEGIN = '# BEGIN GENIE CODEX SESSION HOOK';
const CODEX_SESSION_HOOK_END = '# END GENIE CODEX SESSION HOOK';

type JsonObj = Record<string, unknown>;

/** Claude Code uses an explicit transport `type`; Cursor infers from `url`. */
export function claudeEntry(url: string): JsonObj {
    return { type: 'http', url };
}
export function cursorEntry(url: string): JsonObj {
    return { url };
}

function claudeChannelBridgePath(workspacePath: string): string {
    return path.join(workspacePath, '.agents', '_genie', 'agentinbox-claude-channel.cjs');
}

export function claudeChannelEntry(workspacePath: string, url: string): JsonObj {
    return {
        command: process.execPath,
        args: [claudeChannelBridgePath(workspacePath)],
        env: {
            GENIE_MCP_URL: url,
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
    };
}

const CLAUDE_CHANNEL_OPT_IN =
    `--dangerously-load-development-channels server:${AGENTINBOX_CLAUDE_CHANNEL_NAME}`;

export function withClaudeAgentInboxChannelLaunch(
    command: string,
    input: { agent: string; mcpSyncClaudeOff: boolean; workspacePath: string },
): string {
    if (input.agent !== 'claude' || input.mcpSyncClaudeOff) return command;
    if (command.includes(CLAUDE_CHANNEL_OPT_IN)) return command;
    // genie#319 — the flag names an MCP server the workspace has to actually
    // define, backed by the adapter file below. Appending it on "is claude" and
    // "sync is on" alone promised a channel in workspaces that had neither: the
    // OSA raised Claude Code's dangerous-channels prompt on every launch and
    // then reported `no MCP server configured with that name`. The adapter's
    // presence is what `claudeChannelEntry` points at, so it is the honest
    // precondition — asking costs the user a HITL prompt, so do not ask unless
    // the answer can be yes.
    if (!fs.existsSync(claudeChannelBridgePath(input.workspacePath))) return command;
    return `${command.trim()} ${CLAUDE_CHANNEL_OPT_IN}`;
}

/** Genie-owned Claude Code Channel adapter for the harness-neutral AgentInbox. */
export function claudeChannelBridge(): string {
    return `'use strict';

const endpoint = process.env.GENIE_MCP_URL;
let requestId = 1;
let cursor = 0;
let stopped = false;

function write(message) {
    process.stdout.write(JSON.stringify(message) + '\\n');
}

function writeAccepted(message) {
    return new Promise((resolve, reject) => {
        process.stdout.write(JSON.stringify(message) + '\\n', (error) => error ? reject(error) : resolve());
    });
}

function decodeRpc(body) {
    const lines = body.split(/\\r?\\n/).filter((line) => line.startsWith('data:'));
    const raw = lines.length ? lines.at(-1).slice(5).trim() : body.trim();
    return JSON.parse(raw);
}

async function agentInbox(args) {
    if (!endpoint) throw new Error('GENIE_MCP_URL is required.');
    const id = requestId++;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'agentinbox', arguments: args },
        }),
    });
    if (!response.ok) throw new Error('AgentInbox HTTP ' + response.status);
    const rpc = decodeRpc(await response.text());
    if (rpc.error) throw new Error(rpc.error.message || 'AgentInbox request failed.');
    const text = rpc.result?.content?.find((part) => part.type === 'text')?.text || '';
    const json = text.slice(text.indexOf('{'));
    return JSON.parse(json);
}

async function deliver() {
    await agentInbox({ action: 'registerTransport', transport: 'claude-channel' });
    while (!stopped) {
        const result = await agentInbox({
            action: 'receive', cursor, wait: true, timeoutMs: 240000, acknowledge: false
        });
        for (const message of result.messages || []) {
            await writeAccepted({
                jsonrpc: '2.0',
                method: 'notifications/claude/channel',
                params: {
                    content: message.text,
                    meta: {
                        source: 'genie-agentinbox',
                        messageId: message.id,
                        from: message.from,
                        kind: message.kind,
                    },
                },
            });
            cursor = Number(message.seq || cursor);
            await agentInbox({ action: 'acknowledge', cursor });
        }
    }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method === 'initialize' && message.id !== undefined) {
            write({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    protocolVersion: message.params?.protocolVersion || '2025-06-18',
                    // Declared INSIDE capabilities. It used to sit beside them,
                    // so the client read an EMPTY capability set and no
                    // claude/channel -- a server that starts, answers and works
                    // was declined as unable to do channels, because the
                    // capability was in a place nothing looks.
                    capabilities: { experimental: { 'claude/channel': {} } },
                    serverInfo: { name: 'genie-agentinbox-channel', version: '1' },
                },
            });
        } else if (message.method === 'notifications/initialized') {
            // genie#314 — this line was lost, leaving the .catch body and its
            // closing \`});\` orphaned. The file then failed to parse at all
            // ("SyntaxError: Unexpected token ')'"), so the channel process died
            // before speaking any MCP and the harness reported CONNECTION_CLOSED
            // — and \`deliver()\`, which registers the transport and runs the
            // long-poll that IS the channel, was never called.
            deliver().catch((error) => {
                process.stderr.write('[AgentInbox Channel] ' + error.message + '\\n');
                process.exitCode = 1;
            });
        } else if (message.method === 'ping' && message.id !== undefined) {
            write({ jsonrpc: '2.0', id: message.id, result: {} });
        } else if (message.method === 'tools/list' && message.id !== undefined) {
            write({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
        }
    }
});
process.stdin.on('end', () => { stopped = true; });
`;
}

/** The workspace `.env` key the Tynn project agent token is ALSO landed under.
 *  The `.mcp.json` entry embeds the token as a LITERAL now (see `tynnEntry`), so
 *  the config no longer depends on this — but we still write it (harmless, and
 *  other tooling / a human `${TYNN_AGENT_TOKEN}` reference may read it, and the
 *  offline self-heal re-embeds the literal FROM here). */
export const TYNN_TOKEN_ENV_KEY = 'TYNN_AGENT_TOKEN';

/** Hosts that ARE this machine — plaintext there never leaves the loopback
 *  interface, so it is not a downgrade (Genie's own MCP server is exactly this,
 *  and a local Tynn dev server on `http://localhost:8000` is legitimate). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The MCP-url WRITE BOUNDARY: never persist a REMOTE endpoint as plaintext http
 * (genie#201).
 *
 * `mcp_url` arrives from Tynn's mint response and used to be written verbatim.
 * When Tynn answered `http://tynn.ai/mcp/tynn` that produced two failures at once:
 *
 *   - the entry embeds a LITERAL `Bearer <token>`, so every request would put the
 *     project's agent credential on the wire in the clear;
 *   - tynn.ai answers that url with a 301 to https. An MCP client follows the
 *     redirect, a followed redirect turns the POST into a GET, and laravel/mcp
 *     answers GET with a hardcoded 405 — so the agent could not list one tool.
 *
 * Upgrading here rather than at one call site is what makes it stick: the same
 * value is written to `.mcp.json`, `.cursor/mcp.json` AND `.codex/config.toml`,
 * and it is REWRITTEN on every re-provision — which is why hand-fixing the file
 * kept getting reverted. Loopback is left alone; an unparseable string is returned
 * unchanged (the caller's own validation owns that).
 */
export function secureMcpUrl(url: string): string {
    if (!url) return url;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return url;
    }
    if (parsed.protocol !== 'http:' || LOOPBACK_HOSTS.has(parsed.hostname)) return url;
    parsed.protocol = 'https:';
    return parsed.toString();
}

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

/** Add/remove the managed Codex SessionStart hook without touching user hooks. */
export function applyCodexSessionHookBlock(
    existing: string,
    workspacePath: string,
    enabled: boolean,
): string {
    const escapedBegin = CODEX_SESSION_HOOK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedEnd = CODEX_SESSION_HOOK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const without = existing.replace(
        new RegExp(`${escapedBegin}\\r?\\n[\\s\\S]*?${escapedEnd}(?:\\r?\\n)?`, 'g'),
        '',
    );
    if (!enabled) return without;
    const script = path.join(
        workspacePath,
        '.agents',
        'skills',
        'genie',
        'scripts',
        'register-session.cjs',
    );
    const command = `node "${script}"`;
    const block = [
        CODEX_SESSION_HOOK_BEGIN,
        '[[hooks.SessionStart]]',
        'matcher = "startup|resume|clear"',
        '',
        '[[hooks.SessionStart.hooks]]',
        'type = "command"',
        `command = ${JSON.stringify(command)}`,
        `command_windows = ${JSON.stringify(command)}`,
        'timeout = 10',
        'statusMessage = "Connecting Codex history to AgentInbox"',
        CODEX_SESSION_HOOK_END,
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
    let next = applyCodexServerBlock(existing, name, url, bearerTokenEnvVar, enabled);
    if (name === GENIE_SERVER_NAME) {
        next = applyCodexSessionHookBlock(next, workspacePath, enabled);
    }
    if (next === existing) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, next);
    } catch {
        /* best-effort — launch-time overrides remain the fallback */
    }
}

/**
 * What Genie REGENERATES under `.agents/`, and nothing else.
 *
 * `.agents/` is a tracked folder now: an agent's `AGENT.md` is committed, so
 * agents ship with the project and a change to one is reviewable like any other.
 * That only works if the folder is not also full of files Genie rewrites on
 * every sync, which would leave every workspace permanently dirty.
 *
 * The precision matters in one direction especially. `.agents/skills/` holds
 * BOTH Genie's managed skills and skills the USER wrote — this file guards
 * deletion on the `genie-` prefix for exactly that reason — so ignoring the
 * folder wholesale would quietly stop tracking their own work. The rule is
 * scoped to Genie's prefix instead.
 */
export const GENIE_AGENTS_IGNORE_RULES = [
    '.agents/_genie/',
    '.agents/skills/genie*/',
] as const;

/**
 * Add any missing rules to a `.gitignore`, leaving what is there alone.
 *
 * Idempotent because sync runs on every workspace open: a rule appended each
 * time would grow the file without bound and show up as a diff every session.
 */
export function gitignoreWithRules(
    existing: string,
    rules: readonly string[],
    comment: string,
): string {
    const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
    const missing = rules.filter((rule) => !present.has(rule));
    if (missing.length === 0) return existing;
    // A file with no trailing newline would otherwise join its last line to the
    // first rule, making BOTH wrong -- and a .gitignore that silently stops
    // ignoring `dist` is not noticed until a build directory lands in a PR.
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    return `${existing}${prefix}\n# ${comment}\n${missing.join('\n')}\n`;
}

/** Apply {@link GENIE_AGENTS_IGNORE_RULES} to the workspace's `.gitignore`. */
function ensureGenieAgentsGitignored(workspacePath: string): void {
    const file = path.join(workspacePath, '.gitignore');
    try {
        let existing = '';
        try {
            existing = fs.readFileSync(file, 'utf8');
        } catch {
            /* absent — created below */
        }
        const next = gitignoreWithRules(
            existing,
            GENIE_AGENTS_IGNORE_RULES,
            'Genie: regenerated agent scaffolding (the agents themselves are tracked)',
        );
        if (next !== existing) fs.writeFileSync(file, next);
    } catch {
        /* best-effort — a missing ignore rule is untidy, not broken */
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
 * Weave the PER-TERMINAL genie MCP endpoint into a Codex launch command as a
 * `-c "mcp_servers.genie.url=..."` override (genie #35).
 *
 * The genie endpoint is unlike the workspace-scoped Tynn overrides (applied
 * earlier, in `resolveAgentLaunch`): it MUST be the terminal's OWN endpoint URL
 * so its token self-identifies the terminal server-side (`server.ts`
 * `resolveTerminal` resolves a per-terminal token directly and unambiguously).
 * Pointed at the shared WORKSPACE endpoint instead, a multi-terminal workspace
 * makes the server REFUSE every call that omits `terminalId` — so a Codex agent
 * had to shell out for `$GENIE_TERMINAL_ID` before every targeted call. With the
 * per-terminal URL it never needs to pass `terminalId` at all.
 *
 * This is applied at terminal-CREATE time, where the id (and thus the
 * per-terminal endpoint) first exists — NOT in `resolveAgentLaunch`, which only
 * has the workspace. The `-c` override takes precedence over the workspace
 * `.codex/config.toml` genie block, which stays as a fallback for Codex versions
 * predating that file and for launches before the workspace sync completes.
 *
 * Gated identically to {@link withCodexMcpLaunch}: only a Codex terminal, only
 * when `mcp_sync_codex` is on, and only when an endpoint URL resolved; every
 * other case returns the command unchanged. Pure (the caller mints the URL and
 * reads the setting) so the gating is testable off the terminal pipeline.
 */
export function withCodexGenieMcpLaunch(
    command: string,
    input: { agent: string; mcpSyncCodexOff: boolean; genieUrl?: string | null },
): string {
    if (input.agent !== 'codex' || input.mcpSyncCodexOff || !input.genieUrl) return command;
    return applyCodexMcpLaunchArgs(command, { genieUrl: input.genieUrl });
}

/**
 * ALSO land the Tynn token in the workspace `.env` (gitignored) under
 * `TYNN_AGENT_TOKEN`, preserving any other `.env` lines. The `.mcp.json` entry
 * now embeds the token as a literal (see `tynnEntry`), so the config no longer
 * DEPENDS on this — but we keep writing it because other tooling (or a human
 * `${TYNN_AGENT_TOKEN}` reference) may read it, and the offline self-heal
 * (`healTynnMcpEntry`) reads THIS to re-embed the literal for any workspace
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
    input: { url: string; token: string } | null,
): void {
    if (!workspacePath) return;
    if (enabled && (!input?.url || !input?.token)) return; // never write a broken/empty entry
    // ONE place decides the url that lands on disk, so all three targets agree and
    // a re-provision cannot reintroduce a plaintext remote endpoint (genie#201).
    const opts = input ? { ...input, url: secureMcpUrl(input.url) } : null;
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
 * Self-heal a workspace whose `tynn` entry is on disk but unusable. Two shapes,
 * both fixed WITHOUT a re-mint and WITHOUT the network — a pure on-disk migration,
 * so opening / app startup heals a workspace even offline:
 *
 *  1. the OLD, broken `${TYNN_AGENT_TOKEN}` reference form, which Claude Code /
 *     Cursor refuse to load when the var is unset. Rewritten to the self-contained
 *     literal-token form, reading the token from the workspace's own gitignored
 *     `.env` (where an earlier provision landed it).
 *  2. a plaintext REMOTE url (`http://tynn.ai/…`, genie#201) — the credential in
 *     the clear, and a 301 the client follows into a 405 that leaves the agent with
 *     no Tynn tools at all. Upgraded to https, keeping the token already in the
 *     entry. This is the only thing that reaches workspaces provisioned BEFORE the
 *     write boundary existed: they are `alreadyConfigured`, so nothing re-mints
 *     them and the broken url would sit there forever.
 *
 * A no-op (returns false) when there's nothing to do: no `tynn` entry, no URL, an
 * entry that is already literal AND already secure, or a `${…}` form with no token
 * to embed (those heal via a real re-mint on the next `provisionWorkspaceTynn`).
 * Returns true only when it rewrote the config. Best-effort — callers gitignore.
 */
export function healTynnMcpEntry(workspacePath: string): boolean {
    if (!workspacePath) return false;
    const file = path.join(workspacePath, '.mcp.json');
    const cfg = fs.existsSync(file) ? readJson(file) : null;
    const servers = cfg?.mcpServers as JsonObj | undefined;
    const tynn = servers?.[TYNN_SERVER_NAME] as JsonObj | undefined;
    if (!tynn) return false; // no entry to heal
    const url = typeof tynn.url === 'string' ? tynn.url : '';
    if (!url) return false;
    const secure = secureMcpUrl(url);
    // Already self-contained AND already secure — nothing to rewrite.
    if (hasTynnLiteralToken(workspacePath) && secure === url) return false;
    // The token: the entry's OWN literal when it has one (a scheme-only heal needs
    // nothing else), else the workspace `.env`. Without either we can't embed a
    // literal — leave it for a real re-mint.
    const token =
        readTynnMcpBearerToken(workspacePath) ?? loadWorkspaceEnvVars(workspacePath)[TYNN_TOKEN_ENV_KEY];
    if (!token) return false;
    writeWorkspaceTynnMcp(workspacePath, true, { url: secure, token });
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
/**
 * The coding harnesses Genie writes an instructions file for.
 *
 * TWO REAL FILES, never a symlink: Windows has no working symlinks, so Genie
 * maintains `AGENTS.md` (Codex) and `CLAUDE.md` (Claude Code) itself. They carry
 * the IDENTICAL protocol — only the framing differs, because each is read by a
 * different TUI. Anything genuinely harness-specific (wiring an on-finish hook,
 * codex-server setup) lives in `genieGuide`, NOT here, so the protocol body
 * cannot drift between them. It already had: this envelope's CLAUDE.md went
 * stale enough to lose the entire Hosting Manager section.
 */
export type AgentDocHarness = 'codex' | 'claude';

export const AGENT_DOC_FILES: Record<AgentDocHarness, string> = {
    codex: 'AGENTS.md',
    claude: 'CLAUDE.md',
};

/**
 * A deliberately tiny harness-specific entry point. Each file imports only the
 * shared protocol and the guide for the harness that actually reads it.
 */
export interface AgentDocsContext {
    readme?: boolean;
    rules?: boolean;
}

export function agentDocsRouter(
    filename = AGENT_DOC_FILES.codex,
    context: AgentDocsContext = {},
): string {
    const harness: AgentDocHarness = filename === AGENT_DOC_FILES.claude ? 'claude' : 'codex';
    return [
        '# Agent instructions',
        '',
        context.readme ? '@README.md' : '',
        context.rules ? '@RULES.md' : '',
        '@.agents/_genie/shared.md',
        `@.agents/_genie/genie-${harness}.md`,
        '',
    ].filter((line, index, lines) => line !== '' || index < 2 || index === lines.length - 1).join('\n');
}

function isManagedAgentDocsRouter(content: string, filename: string): boolean {
    return [false, true].some((readme) =>
        [false, true].some((rules) => content === agentDocsRouter(filename, { readme, rules })),
    );
}

/** The one line that differs: which TUI reads this file, and how it gets it. */
const HARNESS_INTRO: Record<AgentDocHarness, string> = {
    codex:
        '> **Codex reads `AGENTS.md`** as the instructions for this workspace. Harness-specific setup — the `notify` on-finish hook, codex-server wiring — is NOT in this protocol: call `genieGuide` for it.',
    claude:
        '> **Claude Code loads `CLAUDE.md`** as project memory at the start of every session. Harness-specific setup — the `Stop` hook, settings wiring — is NOT in this protocol: call `genieGuide` for it.',
};

/**
 * The one line that makes `AGENTS.md` serve Claude Code too.
 *
 * Claude Code reads `CLAUDE.md` and never `AGENTS.md`. Its memory docs specify
 * this import for exactly that case, and recommend it OVER a symlink on Windows,
 * where creating one needs Administrator or Developer Mode — which is the reason
 * Genie was maintaining two copies in the first place.
 */
export const CLAUDE_MD_IMPORT = '@AGENTS.md';

/** Where a human's own Claude-specific notes live, below the import. */
const CLAUDE_SECTION = '## Claude Code';

/**
 * PURE. `CLAUDE.md` as a POINTER at the pristine `AGENTS.md`, never a copy of it.
 *
 * The old design wrote the identical protocol body into both files because
 * Windows has no working symlinks. Its own comment recorded the cost: this
 * envelope's CLAUDE.md "went stale enough to lose the entire Hosting Manager
 * section". Two files holding the same words is a drift generator, and the
 * import removes the second copy rather than trying to keep it in sync.
 *
 * A human's Claude-specific content is KEPT: this file is Genie's to point, not
 * to own outright. Any managed protocol block found in it is REMOVED — that is
 * the migration, and leaving it would leave exactly the staleness being fixed.
 */
export function claudeMdPointer(existing: string, agentsBody?: string): string {
    // Strip a previously-managed protocol block wherever it sits.
    let body = existing;
    const begin = body.indexOf(AGENTS_BEGIN);
    const end = body.indexOf(AGENTS_END);
    if (begin !== -1 && end !== -1 && end > begin) {
        body = body.slice(0, begin) + body.slice(end + AGENTS_END.length);
    }
    // …and the import itself, so re-managing cannot stack a second one.
    body = body
        .split('\n')
        .filter((line) => line.trim() !== CLAUDE_MD_IMPORT)
        .join('\n');

    // DROP what AGENTS.md already says. The previous design kept the two files
    // BYTE-IDENTICAL, so on a workspace Genie was already managing, "the rest" is
    // not a human's Claude-specific content — it is a copy of AGENTS.md. Keeping
    // it made Claude Code load the same words twice, which is what shipped in
    // beta.271 (measured here: 168 lines, 98.8% identical).
    //
    // Line-wise rather than whole-file, so a human's ONE Claude-specific note
    // survives inside an otherwise-mirrored file. Without an AGENTS.md to compare
    // against, nothing is provably duplicated and everything is kept — dropping
    // would be guessing with someone's file.
    if (agentsBody) {
        const theirs = new Set(
            agentsBody
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0),
        );
        body = body
            .split('\n')
            .filter((l) => {
                const t = l.trim();
                return t.length === 0 || !theirs.has(t);
            })
            .join('\n');
    }

    const kept = body.trim();
    return kept
        ? `${CLAUDE_MD_IMPORT}\n\n${kept}\n`
        : `${CLAUDE_MD_IMPORT}\n\n${CLAUDE_SECTION}\n\n<!-- Claude-specific notes only. The protocol lives in AGENTS.md. -->\n`;
}

export function applyAgentsSection(
    existing: string,
    enabled: boolean,
    aiSystem = '',
    harness: AgentDocHarness = 'codex',
): string {
    const trimmed = aiSystem.trim();
    const aiSection = trimmed
        ? `\n\n### Ai.System — workspace instructions (set in Genie → Settings → Customization)\n\n${trimmed}`
        : '';
    const block = `${AGENTS_BEGIN}\n## GENIE PROTOCOL\n\n${HARNESS_INTRO[harness]}\n\n${GENIE_AGENTS_BRIEF}${aiSection}\n${AGENTS_END}`;
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
    // The user's Ai.System instruction set, injected into the blocks below.
    // Best-effort: a settings-read failure must not break the sync.
    let aiSystem = '';
    try {
        aiSystem = (getAllSettings().ai_system as string) ?? '';
    } catch {
        /* leave empty — sync proceeds with the brief-only block */
    }

    // BOTH harness files, because Windows has no working symlinks: Genie cannot
    // point CLAUDE.md at AGENTS.md, it has to maintain each one. If EITHER
    // exists the workspace uses agent instructions, so the other is created too
    // — otherwise whichever harness you open next is flying blind. (That is not
    // hypothetical: a CLAUDE.md that was never managed went stale enough to lose
    // the entire Hosting Manager section.) A workspace with NEITHER file is left
    // alone, so Genie still never litters into a project that uses neither.
    const targets = (Object.keys(AGENT_DOC_FILES) as AgentDocHarness[]).map((harness) => ({
        harness,
        file: path.join(workspacePath, AGENT_DOC_FILES[harness]),
    }));
    const read = targets.map((t) => {
        try {
            return { ...t, existing: fs.readFileSync(t.file, 'utf8'), present: true };
        } catch {
            return { ...t, existing: '', present: false };
        }
    });
    if (!read.some((t) => t.present)) return; // no agent docs here → nothing to do

    if (enabled) {
        const managedRoot = path.join(workspacePath, '.agents', '_genie');
        const backupRoot = path.join(managedRoot, 'backups');
        try {
            fs.mkdirSync(backupRoot, { recursive: true });
        } catch {
            /* individual writes below remain best-effort */
        }

        // Back up each pre-router document exactly once, before replacing either
        // entry point. Stable names make recovery discoverable and ensure a later
        // sync can never overwrite the original snapshot.
        for (const target of read) {
            if (!target.present || isManagedAgentDocsRouter(target.existing, AGENT_DOC_FILES[target.harness])) continue;
            const backup = path.join(backupRoot, `${AGENT_DOC_FILES[target.harness]}.pre-router.bak`);
            if (!fs.existsSync(backup)) {
                try {
                    fs.writeFileSync(backup, target.existing);
                } catch {
                    return; // backup-first is a safety boundary, not best-effort
                }
            }
        }

        const stripManaged = (content: string): string => {
            if (Object.values(AGENT_DOC_FILES).some((file) => isManagedAgentDocsRouter(content, file))) return '';
            let body = content;
            const begin = body.indexOf(AGENTS_BEGIN);
            const end = body.indexOf(AGENTS_END);
            if (begin !== -1 && end !== -1 && end > begin) {
                body = body.slice(0, begin) + body.slice(end + AGENTS_END.length);
            }
            return body
                .split('\n')
                .filter((line) => line.trim() !== CLAUDE_MD_IMPORT)
                .join('\n')
                .replace(/## Claude Code\s*<!-- Claude-specific notes only\.[\s\S]*?-->/g, '')
                .trim();
        };

        const migrated = Array.from(
            new Set(read.map((target) => stripManaged(target.existing)).filter(Boolean)),
        );
        if (migrated.length > 0) {
            const rulesFile = path.join(workspacePath, 'RULES.md');
            let existingRules = '';
            try {
                existingRules = fs.readFileSync(rulesFile, 'utf8');
            } catch {
                /* create it below */
            }
            const additions = migrated.filter((body) => !existingRules.includes(body));
            if (additions.length > 0) {
                const prefix = existingRules.trim()
                    ? `${existingRules.replace(/\s+$/, '')}\n\n`
                    : '# Workspace rules\n\n';
                const section = [
                    '<!-- BEGIN GENIE INSTRUCTION MIGRATION -->',
                    '## Migrated agent instructions',
                    '',
                    ...additions.flatMap((body, index) => [
                        `### Source ${index + 1}`,
                        '',
                        body,
                        '',
                    ]),
                    '<!-- END GENIE INSTRUCTION MIGRATION -->',
                    '',
                ].join('\n');
                try {
                    fs.writeFileSync(rulesFile, prefix + section);
                } catch {
                    return; // never install routers that would orphan the rules
                }
            }
        }

        const shared = [
            AGENTS_BEGIN,
            '## GENIE PROTOCOL',
            '',
            GENIE_AGENTS_BRIEF,
            aiSystem.trim()
                ? `\n### Ai.System — workspace instructions (set in Genie → Settings → Customization)\n\n${aiSystem.trim()}`
                : '',
            AGENTS_END,
            '',
        ].join('\n');
        const providerDocs: Record<string, string> = {
            codex: '# Genie for Codex\n\nCodex must call `genieGuide` and follow the Codex-specific setup it returns.\n',
            claude: '# Genie for Claude Code\n\nClaude Code must call `genieGuide` and follow the Claude-specific setup it returns.\n',
            kiwi: '# Genie for Kiwi Code\n\nKiwi Code must call `genieGuide` and follow the Kiwi-specific setup it returns.\n',
            genie: '# Genie for Genie TUI\n\nGenie TUI must call `genieGuide` and follow the Genie TUI-specific setup it returns.\n',
            custom: '# Genie for Custom agent\n\nThe custom agent must call `genieGuide` and follow the setup for its harness.\n',
        };
        try {
            // `.agents/` is TRACKED now -- an agent's AGENT.md ships with the
            // project -- so what Genie regenerates under it has to be ignored,
            // or every workspace would sit permanently dirty.
            ensureGenieAgentsGitignored(workspacePath);
            fs.writeFileSync(path.join(managedRoot, 'shared.md'), shared);
            for (const [provider, content] of Object.entries(providerDocs)) {
                fs.writeFileSync(path.join(managedRoot, `genie-${provider}.md`), content);
            }
            const context = {
                readme: fs.existsSync(path.join(workspacePath, 'README.md')),
                rules: fs.existsSync(path.join(workspacePath, 'RULES.md')),
            };
            fs.writeFileSync(
                path.join(workspacePath, AGENT_DOC_FILES.codex),
                agentDocsRouter(AGENT_DOC_FILES.codex, context),
            );
            fs.writeFileSync(
                path.join(workspacePath, AGENT_DOC_FILES.claude),
                agentDocsRouter(AGENT_DOC_FILES.claude, context),
            );
        } catch {
            /* backups and migrated rules remain recoverable */
        }
        return;
    }

    // Disabling only STRIPS the block; it must never create a file to strip from.
    for (const t of read) {
        if (!enabled && !t.present) continue;
        // AGENTS.md is the PRISTINE file Genie manages; CLAUDE.md only POINTS at
        // it (`@AGENTS.md`). Genie used to write the identical body into both,
        // because Windows has no working symlinks — and the drift that produced
        // is what this replaces. Disabling still strips rather than points: a
        // workspace that has opted out should not be left importing a protocol
        // that is no longer there.
        const next =
            t.harness === 'claude' && enabled
                ? claudeMdPointer(t.existing, read.find((r) => r.harness === 'codex')?.existing)
                : applyAgentsSection(t.existing, enabled, aiSystem, t.harness);
        if (next === t.existing) continue;
        try {
            fs.writeFileSync(t.file, next);
        } catch {
            /* best-effort */
        }
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

1. In a fresh or newly converted workspace, call \`connectToGenie\` and follow its repository-orientation plan.
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

/** Built into the immutable Genie workstation agent; never synced to projects. */
export function osAgentBuilderSkill(): string {
    return `---
name: genie-agent-builder
description: Use only as Genie's built-in workstation operator when the user asks to create or configure an AMS agent for a workspace.
---

# AgentBuilder

You are the hardcoded Genie OS agent and workstation operator. Build durable AMS
agents for workspaces; never perform their project work yourself.

1. Use \`manageWorkspaces list\` to resolve the exact target workspace. Never guess.
2. Gather the agent's stable name, purpose, model provider, optional command,
   working folder, access scope, wake behavior, and IssueWatch behavior. Ask the
   user one concise \`ForceTheQuestion\` batch for anything material that is missing.
3. Call \`registerAgent\` with the explicit target \`workspaceId\`. Registration
   creates durable identity/configuration only; do not create a terminal panel.
4. Confirm the saved result. Call \`runAgent start\` only when the user also asked
   to launch it; starting produces its distinct AgentPanel on the Floor.
5. Never edit agent tables or workspace manifests directly, and never use
   \`manageTerminals create\` as a substitute for an AMS agent.
`;
}

/** Focused Genie workflow skills installed beside the base routing skill. */
export function genieCoreSkills(): Record<string, string> {
    const skill = (name: string, description: string, body: string): string => `---
name: ${name}
description: ${description}
---

${body}
`;
    return {
        'genie-orientation': skill(
            'genie-orientation',
            'Use when entering, reinitializing, or learning a Genie workspace.',
            `# Genie workspace orientation

Call \`connectToGenie\` once for a fresh or newly converted workspace. Follow its numbered plan, treat repos as the primary source, and review the Agent integration health section before starting work. Read the nearest AGENTS.md and repository instructions before changing code.`,
        ),
        'genie-attention': skill(
            'genie-attention',
            'Use when finishing work, handing back, surfacing a file, or needing a user decision in Genie.',
            `# Genie attention

Call \`imDone\` every time you hand work back. Use \`ForceTheQuestion\` for a blocking decision, batch all questions, and name the actor in every option. Use \`openFileForUser\` to put a relevant result in front of the user. Pass \`GENIE_TERMINAL_ID\` whenever available.`,
        ),
        'genie-agentinbox': skill(
            'genie-agentinbox',
            'Use for Genie AgentInbox discovery, messaging, channels, accessibility, receipts, and Codex session binding.',
            `# Genie AgentInbox

Use \`agentinbox\` to list peers, send DMs or channel messages, receive new messages, inspect receipts, and manage accessibility or channel membership. To await a reply, make one blocking receive with \`wait:true\`; do not poll.

Genie owns Codex session binding. Its generated SessionStart hook calls the internal \`registerSession\` action to rebind the generated session id to the existing agent and history in place. Do not hand-edit that hook or manually create another registration. If Codex reports that hooks await trust review, use \`/hooks\` once; Genie never bypasses Codex trust.`,
        ),
        'genie-terminals': skill(
            'genie-terminals',
            'Use when managing Genie terminals, coding agents, or supervised background processes.',
            `# Genie terminals and processes

Use \`manageTerminals\` to create, drive, read, or stop terminals; \`runAgent\` for coding agents; and \`manageProcess\` for long-running servers or workers that should survive terminal activity. Creation and writes may require user approval.`,
        ),
        'genie-workspaces': skill(
            'genie-workspaces',
            'Use when listing, opening, activating, removing, provisioning, or scaffolding Genie workspaces.',
            `# Genie workspaces

Use \`manageWorkspaces\` for registered workspaces. Removal only unregisters a workspace and never deletes its files. In an Ops workspace, use \`provisionWorkspaces\` for governed children and respect its approval gates.`,
        ),
        'genie-knowledge': skill(
            'genie-knowledge',
            'Use when reading or recording durable workstation-wide Genie knowledge.',
            `# Genie knowledge

Search the knowledge graph before adding a node. Keep memories small and reusable, retrieve full nodes only when relevant, and connect related knowledge with wikilinks. The graph is workstation-wide, not workspace-local.`,
        ),
        'genie-issuewatch': skill(
            'genie-issuewatch',
            'Use when inspecting Genie IssueWatch issues, pull requests, security alerts, and unresolved project feedback.',
            `# Genie IssueWatch

Use \`checkIssues\` for the detailed workspace feed. \`imDone\` also reports open counts. Treat security alerts according to workspace policy and fix root causes rather than masking them.

The \`feedback:\` count is unresolved project feedback in Tynn — NOT a GitHub item and NOT a failure. It is input from outside the build waiting on triage: read it with the Tynn \`feedback\` tool and convert what should become work, but never close entries to bring the number down, because judging whether a piece of feedback is worth acting on is a human call.`,
        ),
        'genie-gdw': skill(
            'genie-gdw',
            'Use when building a Genie App in a GApp Development Workspace or updating one to the current shared schemas.',
            `# Build and update a Genie App

Call \`manageGappDev\` with \`action: "status"\` first; the filesystem alone cannot tell you whether this is a GDW. The canonical developer-owned manifest is \`gapp.json\`, pinned to \`https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.2.0/schemas/workspace/gapp.schema.json\`. The managed workspace file is \`project.json\`, pinned to the matching v0.2.0 schema.

For an older app, back up each file before changing it, refuse when both \`genie-app.json\` and \`gapp.json\` exist, rename \`genie-app.json\` to \`gapp.json\` only after validation, then run \`manageGappDev check\`. Use \`preview\` only after check is clean. Never add a compatibility reader or silently discard unknown fields.`,
        ),
    };
}

/** Script invoked by Codex's SessionStart hook; stdin is the documented hook payload. */
export function codexSessionRegistrationHook(): string {
    return `'use strict';

let input = '';
const attempts = 3;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    input += chunk;
});
process.stdin.on('end', async () => {
    try {
        const payload = JSON.parse(input);
        const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
        const endpoint = process.env.GENIE_MCP_URL;
        if (!sessionId || !endpoint) return;
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: 'codex-session-start',
            method: 'tools/call',
            params: {
                name: 'agentinbox',
                arguments: { action: 'registerSession', sessionId },
            },
        });
        let response;
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body,
                    signal: AbortSignal.timeout(8000),
                });
                if (response.ok || response.status < 500) break;
                lastError = new Error(
                    'Genie session registration request failed (' + response.status + ')',
                );
            } catch (error) {
                lastError = error;
            }
            if (attempt < attempts) await delay(150 * attempt);
        }
        if (!response?.ok) {
            throw lastError ?? new Error('Genie session registration request failed');
        }
        const result = await response.json();
        if (result.error || result.result?.isError) {
            throw new Error('Genie rejected Codex session registration');
        }
    } catch (error) {
        process.stderr.write(
            \`Genie could not connect this Codex session to AgentInbox: \${
                error instanceof Error ? error.message : String(error)
            \}\\n\`,
        );
        process.exitCode = 1;
    }
});
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
 * Sync the repo-scoped skills for ONE agent: Genie's routing + focused workflow
 * skills, plus a skill per enabled plugin that declares `agent.guide`.
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
        const coreSkills = { genie: genieCodexSkill(), ...genieCoreSkills() };
        const codexSessionHook = path.join(
            root,
            'genie',
            'scripts',
            'register-session.cjs',
        );
        const skills = enabled ? pluginAgentSkills() : [];
        const wanted = new Map(
            skills.map((s) => [`${PLUGIN_SKILL_PREFIX}${s.namespace}`, pluginSkillBody(s)]),
        );

        if (!enabled) {
            for (const [name, body] of Object.entries(coreSkills)) {
                const file = path.join(root, name, 'SKILL.md');
                if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) {
                    fs.rmSync(file);
                }
            }
            if (
                agent === 'codex' &&
                fs.existsSync(codexSessionHook) &&
                fs.readFileSync(codexSessionHook, 'utf8') === codexSessionRegistrationHook()
            ) {
                fs.rmSync(codexSessionHook);
            }
        } else {
            for (const [name, body] of Object.entries(coreSkills)) {
                writeIfChanged(path.join(root, name, 'SKILL.md'), body);
            }
            if (agent === 'codex') {
                writeIfChanged(codexSessionHook, codexSessionRegistrationHook());
            }
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
            upsert(
                path.join(workspacePath, '.mcp.json'),
                AGENTINBOX_CLAUDE_CHANNEL_NAME,
                {},
                false,
            );
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
        upsert(
            path.join(workspacePath, '.mcp.json'),
            AGENTINBOX_CLAUDE_CHANNEL_NAME,
            claudeChannelEntry(workspacePath, url ?? ''),
            enabled,
        );
        if (enabled) {
            writeIfChanged(claudeChannelBridgePath(workspacePath), claudeChannelBridge());
        }
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
