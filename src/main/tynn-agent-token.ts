import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import { tynnProjectIdOf } from '../core/issue-watch.js';
import type { SyncFlags, SyncFs } from './config-sync-targets.js';
import type { AgentRecord } from '../core/identity.js';
import { tynnAgentIdentities, type AgentCredentialPorts } from './tynn-agent-identities.js';

/**
 * TYNN AGENT-TOKEN SETUP (add-workspace parity item 4; Genie 1 `main/tynn/provision.ts`). A workspace whose project.json
 * links a Tynn project (`tynn.projectId`) gets a Tynn MCP agent token, so the agents working in it can reach Tynn —
 * without it an imported or linked workspace's agents cannot.
 *
 * - WHERE THE TOKEN COMES FROM: Tynn's `POST /api/v1/projects/agent-token` (MeApiController::mintAgentToken), over the
 *   person's signed-in Tynn session (main/tynn-account.ts) — the same call Genie 1 made. Tynn answers the token ONCE.
 * - WHERE IT GOES: this module decides only the url and token; config sync (main/config-sync-targets.ts) writes the
 *   `tynn` server into the same harness configs as Genie's own `genie` server. One writer.
 * - NEVER COMMITTED: the files that will carry it are gitignored BEFORE a token exists; if that cannot be done, nothing
 *   is minted. The token is never logged and never part of a result or a reason.
 * - MINTED ONCE: every mint is a NEW live token in Tynn (MintProjectAgentToken creates a key and revokes none), so a
 *   workspace whose configs already carry a literal Tynn token reuses it — Genie 1's `hasTynnLiteralToken` rule, read
 *   from any of the three configs so a harness switched off does not cause a re-mint. Two syncs at once mint once.
 *
 * Genie 1 also sent `workspace_envelope` and, for an already-provisioned envelope, called `declare-envelope` with the
 * project id alone. Tynn now accepts the first and does nothing with it, and the second only registers a container
 * remote when given one ("every project is a workspace now") — so neither is sent.
 */

/** The signed-in Tynn session, as TynnAccount provides it. */
export interface TynnSessionPort {
    status(): { readonly signedIn: boolean };
    userId?(): string | null;
    request(path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export interface TynnMcp {
    readonly url: string;
    readonly token: string;
}

export type TynnAgentToken =
    /** No `tynn.projectId` in project.json: not Tynn's business. */
    | { readonly status: 'unlinked' }
    | { readonly status: 'already' | 'minted'; readonly mcp: TynnMcp; readonly remoteAgentId?: string }
    | { readonly status: 'failed'; readonly reason: string; readonly code?: 'offline' | 'inactive' | 'conflict' | 'pending' | 'storage' | 'refused' };

export const TYNN_SERVER_KEY = 'tynn';

/** Hosts that ARE this machine: plaintext there never leaves the loopback interface. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Never write a REMOTE endpoint as plaintext http (Genie 1, genie#201): the entry carries a literal bearer token, and
 * tynn.ai answers http with a 301 an MCP client follows into a 405. Loopback stays as it is; unparseable is unchanged.
 */
export function secureMcpUrl(url: string): string {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return url; }
    if (parsed.protocol !== 'http:' || LOOPBACK_HOSTS.has(parsed.hostname)) return url;
    parsed.protocol = 'https:';
    return parsed.toString();
}

/** A literal `Bearer <token>` — not empty, not an `${ENV}` reference (Genie 1's older form, which harnesses refuse). */
function literalBearer(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const m = /^Bearer\s+(.+)$/.exec(value.trim());
    const token = m?.[1]?.trim() ?? '';
    return token.length > 0 && !token.includes('${') ? token : null;
}

function fromJson(text: string | null): TynnMcp | null {
    if (text === null) return null;
    try {
        const entry = (JSON.parse(text) as { mcpServers?: Record<string, { url?: unknown; headers?: { Authorization?: unknown } }> } | null)?.mcpServers?.[TYNN_SERVER_KEY];
        const token = literalBearer(entry?.headers?.Authorization);
        return token && typeof entry?.url === 'string' && entry.url.trim() ? { url: entry.url, token } : null;
    } catch {
        return null;
    }
}

/** Genie's own managed Codex block for Tynn (config-sync-targets.ts writes it). */
export const TYNN_TOML_BEGIN = '# >>> tynn — managed by Genie; edits between the markers are replaced on sync';
export const TYNN_TOML_END = '# <<< tynn';

function fromToml(text: string | null): TynnMcp | null {
    if (text === null) return null;
    const begin = text.indexOf(TYNN_TOML_BEGIN);
    const end = text.indexOf(TYNN_TOML_END);
    if (begin < 0 || end <= begin) return null;
    const block = text.slice(begin, end);
    const url = /^url = "([^"]+)"$/m.exec(block)?.[1];
    const token = literalBearer(/Authorization = "([^"]+)"/.exec(block)?.[1]);
    return url && token ? { url, token } : null;
}

/**
 * THE TYNN SERVER A SESSION STARTS WITH (2026-10-22): the one config sync wrote into the workspace (`.codex/config.toml`
 * — or the Claude / Cursor config, same token), read back, as a session `mcpServers` entry beside Genie's own. Codex loads
 * `[mcp_servers.tynn]` from the file on its own, but asks before its tools run, and a session can only approve a server it
 * was GIVEN (prism-acp: `mcpToolApproval names "tynn", which is not one of the MCP servers given`) — so it is given, the
 * way `genie` is. Nothing is minted here; `read` is synchronous because a session starts synchronously. None = [].
 */
export function tynnMcpServersOnDisk(workspacePath: string, read: (path: string) => string | null): McpServer[] {
    const at = (...parts: string[]) => join(workspacePath, ...parts).replace(/\\/g, '/');
    const mcp = fromJson(read(at('.mcp.json'))) ?? fromJson(read(at('.cursor', 'mcp.json'))) ?? fromToml(read(at('.codex', 'config.toml')));
    return mcp ? [{ type: 'http', name: TYNN_SERVER_KEY, url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }] : [];
}

/** The Tynn token a sync already wrote into any of the three configs, or null. */
async function onDisk(workspacePath: string, fs: SyncFs): Promise<TynnMcp | null> {
    const at = (...parts: string[]) => join(workspacePath, ...parts).replace(/\\/g, '/');
    return fromJson(await fs.read(at('.mcp.json'))) ?? fromJson(await fs.read(at('.cursor', 'mcp.json'))) ?? fromToml(await fs.read(at('.codex', 'config.toml')));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function mint(tynn: TynnSessionPort, projectId: string): Promise<TynnMcp | string> {
    let res: Awaited<ReturnType<TynnSessionPort['request']>>;
    try {
        res = await tynn.request('/api/v1/projects/agent-token', { method: 'POST', body: { project_id: projectId } });
    } catch (error) {
        return `Tynn could not be reached (${message(error)})`;
    }
    const body = (await res.json().catch(() => null)) as { token?: unknown; mcp_url?: unknown; error?: unknown; message?: unknown } | null;
    if (!res.ok) {
        // Only Tynn's own error words — never the body, which on success carries the token.
        const why = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : null;
        return `Tynn answered ${res.status}${why ? ` (${why})` : ''}`;
    }
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const url = typeof body?.mcp_url === 'string' ? body.mcp_url.trim() : '';
    if (!token || !url) return 'Tynn answered without a token or an MCP address';
    return { url: secureMcpUrl(url), token };
}

/** One per Genie: a workspace being set up already is waited on, not minted for twice. */
export function tynnAgentTokens(credentials?: AgentCredentialPorts) {
    const identities = credentials ? tynnAgentIdentities(credentials) : null;
    const inFlight = new Map<string, Promise<TynnAgentToken>>();
    // What this Genie minted, per workspace and project: a write that failed after the mint, or a sync that read the disk
    // before the first one wrote, reuses it rather than minting another live token.
    const minted = new Map<string, TynnMcp>();

    async function decide(input: { workspacePath: string; fs: SyncFs; flags: SyncFlags; tynn: TynnSessionPort | null; ignore: () => Promise<void> }): Promise<TynnAgentToken> {
        const { workspacePath, fs, flags } = input;
        const projectId = tynnProjectIdOf(await fs.read(join(workspacePath, 'project.json').replace(/\\/g, '/')));
        if (projectId === null) return { status: 'unlinked' };
        const fail = (why: string): TynnAgentToken => ({ status: 'failed', reason: `this workspace is linked to Tynn, but its agents have no Tynn token: ${why}` });
        if (!flags.mcp_sync_claude && !flags.mcp_sync_cursor && !flags.mcp_sync_codex) return fail('the Claude Code, Cursor and Codex config sync are all off, so there is nowhere to write one');
        // The token files are kept out of a commit FIRST — before a token is reused into more files or a new one exists.
        try {
            await input.ignore();
        } catch (error) {
            return fail(`the .gitignore that keeps it out of a commit could not be written (${message(error)}), so none was asked for`);
        }
        const remembered = `${workspacePath.replace(/\\/g, '/')}|${projectId}`;
        const existing = (await onDisk(workspacePath, fs)) ?? minted.get(remembered) ?? null;
        if (existing) return { status: 'already', mcp: { url: secureMcpUrl(existing.url), token: existing.token } };
        if (!input.tynn || !input.tynn.status().signedIn) return fail('this Genie is signed out of Tynn — sign in (Settings → Accounts → Tynn) and it gets one');
        const fresh = await mint(input.tynn, projectId);
        if (typeof fresh === 'string') return fail(fresh);
        minted.set(remembered, fresh);
        return { status: 'minted', mcp: fresh };
    }

    return {
        ensure(input: Parameters<typeof decide>[0] & { agent?: AgentRecord }): Promise<TynnAgentToken> {
            if (input.agent) {
                if (!identities) return Promise.resolve({ status: 'failed', code: 'storage', reason: 'Private Tynn agent credential storage is not configured.' });
                return input.fs.read(join(input.workspacePath, 'project.json').replace(/\\/g, '/')).then((text): Promise<TynnAgentToken> | TynnAgentToken => {
                    const projectId = tynnProjectIdOf(text);
                    return projectId ? identities.ensure({ projectId, agent: input.agent!, tynn: input.tynn }) : { status: 'unlinked' };
                }).catch((): TynnAgentToken => ({ status: 'failed', code: 'storage', reason: 'The workspace Tynn link could not be read.' }));
            }
            const key = input.workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
            const running = inFlight.get(key);
            if (running) return running;
            const next = decide(input).finally(() => inFlight.delete(key));
            inFlight.set(key, next);
            return next;
        },
    };
}
