import { mcpOffFor, REQUIRED_MCP } from './agent-mcp.js';

/**
 * AN AGENT'S APP MCP SERVERS (Tynn #1033; the owner, 2026-11-22: "Genie agents need to be able to use mcp connections
 * locally made by apps they are building on a per agent basis that is configurable in the agent settings").
 *
 * Per agent, on its record (`appMcp`), each one of:
 *
 * - `{ name, site, path }`: one of its workspace's Genie sites (by id) and the path its app serves MCP on (`/mcp`, a
 *   Laravel app's mcp route). The address is NOT kept: it is resolved at each session start through Genie's own router
 *   (`routes()`, the loopback target the `.gen` front door proxies to), because a site's port changes when it restarts.
 *   A site that is not running is not handed, and says so.
 * - `{ name, url }`: a loopback URL the person (or the default agent, with the person's approval) entered.
 *
 * LOCAL ONLY, NO SECRETS: an address off this machine is refused, and so is anything that would carry a key (credentials
 * in the URL, a query or fragment, headers, a token); keys belong in the vault (Tynn #1024), not on a record.
 * NOT IN A WORKSPACE THAT IS NOT TRUSTED: an app's MCP server is the app's own code acting as the agent's tools, so an
 * untrusted workspace's agent is handed none (as its `sites` and `services` tools refuse there).
 *
 * Each is switched on and off like any server (core/agent-mcp.ts mcpOffFor): one that is off is not handed at all, so it
 * costs the agent no context. Handed through the same per-session path as genie and tynn (main/session-host.ts
 * `appMcpServersFor`), after them and never in their place.
 */

export type AppMcpEntry =
    | { readonly name: string; readonly site: string; readonly path: string }
    | { readonly name: string; readonly url: string };

/** A site of the workspace as this module needs it (main/site-manager.ts SiteInfo). */
export interface AppSite { readonly id: string; readonly name: string; readonly host: string }
/** A background process as this module needs it (main/process-supervisor.ts ProcessSpec). */
export interface AppProcess { readonly id: string; readonly name: string; readonly command: string; readonly env?: Readonly<Record<string, string>> | undefined }
/** The router's table (core/gen-router.ts GenRoute): `<name>.gen → 127.0.0.1:<port>` for every site that is up. */
export interface AppRoute { readonly host: string; readonly target: string }

export interface AppMcpCandidate {
    readonly kind: 'site' | 'process';
    readonly name: string;
    /** A site's id: what an add of this candidate names. */
    readonly site?: string;
    /** What the person reads: the site's host, or the process's name. */
    readonly label: string;
    /** Where it would be reached: a site's `.gen` address, or the process's loopback port. */
    readonly url: string;
    /** The agent already has it. */
    readonly added: boolean;
}

/** prism-acp's `McpServer`, http: the shape handed to a session. */
export interface AppMcpServer { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] }

export const DEFAULT_APP_MCP_PATH = '/mcp';
const MAX_ENTRIES = 20;
/** Names Genie keeps for the servers it hands every session itself (its own, and the Fancy Dev Kit's, Tynn #1017). */
const RESERVED: readonly string[] = [...REQUIRED_MCP, 'fancy-ui'];
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PATH = /^\/[A-Za-z0-9._~\/-]{0,199}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const INPUT_KEYS = new Set(['name', 'site', 'path', 'url']);

export const APP_MCP_WORDS = {
    title: 'App MCP',
    note: (agent: string) => `MCP servers the apps in this workspace serve, for ${agent} alone: a Genie site’s /mcp, or a local address. Each is reached through Genie at ${agent}’s next session start; a site that is not running then is left out until the one after.`,
    localOnly: 'Only a local address: one of this workspace’s Genie sites, or http://localhost, 127.0.0.1 or [::1] with its port.',
    noSecrets: 'An app MCP server carries no keys here: no credentials, query, headers or token. Put a key in Genie’s vault (Tynn #1024) instead.',
    noSite: (site: string) => `This workspace has no site “${site}”; \`sites list\` shows them.`,
    what: 'Say one of: a site of this workspace (`site`, with an optional `path`), or a local `url`.',
    path: 'The path is the app’s MCP route, starting with / (e.g. /mcp), with no spaces, query or fragment.',
    name: 'The name is letters, digits, dots, dashes and underscores, up to 64.',
    reserved: (name: string) => `“${name}” is the name of a server Genie hands every agent itself; choose another.`,
    taken: (name: string) => `It already has an MCP server named “${name}”.`,
    unknown: (name: string) => `It has no app MCP server named “${name}”.`,
    full: `An agent has at most ${MAX_ENTRIES} app MCP servers.`,
    notRunning: (host: string) => `${host} is not running, so its MCP server was left out of this session.`,
    siteGone: 'Its site is no longer in this workspace, so it was left out.',
    untrusted: 'This workspace is not trusted, so no app’s MCP server is handed to its agents.',
    invalid: 'Its saved address is not one Genie hands an agent (not local, or not a server name), so it was left out.',
    saved: (agent: string) => `Saved. It applies the next time ${agent} starts a session.`,
    add: 'Add',
    remove: 'Remove',
    urlLabel: 'A local MCP address',
    urlPlaceholder: 'http://127.0.0.1:8000/mcp',
    none: 'None yet.',
} as const;

type Parsed = { ok: true; entry: AppMcpEntry } | { ok: false; reason: string };
type Listed = { ok: true; list: AppMcpEntry[] } | { ok: false; reason: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64) || 'app';
const findSite = (sites: readonly AppSite[], key: string): AppSite | undefined => sites.find((s) => s.id === key || s.name === key || s.host === key.toLowerCase());

function nameRefusal(name: string): string | null {
    if (!NAME.test(name)) return APP_MCP_WORDS.name;
    if (RESERVED.includes(name.toLowerCase())) return APP_MCP_WORDS.reserved(name);
    return null;
}

/** A URL Genie may hand an agent: http(s) on loopback, with no credentials, query or fragment. `null` otherwise. */
function loopbackUrl(raw: string): URL | 'secret' | null {
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || /[?#]/.test(raw)) return 'secret';
    return url;
}

/**
 * What someone asked to add, checked: the entry kept on the record, or the refusal in words. `sites` are the agent's
 * workspace's: a site elsewhere is "no site" here.
 */
export function parseAppMcpEntry(input: unknown, sites: readonly AppSite[]): Parsed {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: APP_MCP_WORDS.what };
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !INPUT_KEYS.has(key) && raw[key] !== undefined)) return { ok: false, reason: APP_MCP_WORDS.noSecrets };
    const site = str(raw.site);
    const url = str(raw.url);
    const given = str(raw.name);
    if ((site === undefined) === (url === undefined)) return { ok: false, reason: APP_MCP_WORDS.what };

    const forSite = (found: AppSite, path: string): Parsed => {
        if (/[?#]/.test(path)) return { ok: false, reason: APP_MCP_WORDS.noSecrets };
        if (!PATH.test(path)) return { ok: false, reason: APP_MCP_WORDS.path };
        const name = given ?? slug(found.name);
        const refusal = nameRefusal(name);
        return refusal ? { ok: false, reason: refusal } : { ok: true, entry: { name, site: found.id, path } };
    };

    if (site !== undefined) {
        const found = findSite(sites, site);
        if (!found) return { ok: false, reason: APP_MCP_WORDS.noSite(site) };
        return forSite(found, str(raw.path) ?? DEFAULT_APP_MCP_PATH);
    }
    if (raw.path !== undefined) return { ok: false, reason: APP_MCP_WORDS.what };
    const parsed = loopbackUrl(url!);
    if (parsed === 'secret') return { ok: false, reason: APP_MCP_WORDS.noSecrets };
    if (parsed === null) return { ok: false, reason: APP_MCP_WORDS.localOnly };
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('.gen')) {
        const found = findSite(sites, host);
        if (!found) return { ok: false, reason: APP_MCP_WORDS.noSite(host) };
        return forSite(found, parsed.pathname === '/' ? DEFAULT_APP_MCP_PATH : parsed.pathname);
    }
    if (!LOOPBACK.has(host) || parsed.port === '') return { ok: false, reason: APP_MCP_WORDS.localOnly };
    if (!PATH.test(parsed.pathname)) return { ok: false, reason: APP_MCP_WORDS.path };
    const name = given ?? `app-${parsed.port}`;
    const refusal = nameRefusal(name);
    return refusal ? { ok: false, reason: refusal } : { ok: true, entry: { name, url: `${parsed.protocol}//${parsed.host}${parsed.pathname}` } };
}

/** The list with one more; a name it already has, or a full list, is refused. */
export function withAppMcp(list: readonly AppMcpEntry[] | undefined, entry: AppMcpEntry): Listed {
    const now = [...(list ?? [])];
    if (now.some((e) => e.name.toLowerCase() === entry.name.toLowerCase())) return { ok: false, reason: APP_MCP_WORDS.taken(entry.name) };
    if (now.length >= MAX_ENTRIES) return { ok: false, reason: APP_MCP_WORDS.full };
    return { ok: true, list: [...now, entry] };
}

/** The list without the one of that name; a name it does not have is refused. */
export function withoutAppMcp(list: readonly AppMcpEntry[] | undefined, name: unknown): Listed {
    const now = [...(list ?? [])];
    const key = typeof name === 'string' ? name.trim() : '';
    if (!now.some((e) => e.name === key)) return { ok: false, reason: APP_MCP_WORDS.unknown(key) };
    return { ok: true, list: now.filter((e) => e.name !== key) };
}

/** The port a process says it listens on: its `PORT`, or its command's `--port N` / `--port=N`. `null` when it says none. */
function processPort(p: AppProcess): number | null {
    const fromEnv = p.env?.PORT;
    const raw = fromEnv !== undefined && /^\d+$/.test(fromEnv) ? fromEnv : /(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/.exec(p.command)?.[1];
    const port = raw === undefined ? NaN : Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** What Genie offers to add: every site of the workspace at /mcp, then every process whose port it can read. */
export function appMcpCandidates(sites: readonly AppSite[], processes: readonly AppProcess[], have: readonly AppMcpEntry[] | undefined): AppMcpCandidate[] {
    const list = have ?? [];
    const hasSite = (id: string) => list.some((e) => 'site' in e && e.site === id);
    const hasUrl = (url: string) => list.some((e) => 'url' in e && e.url === url);
    const fromSites = sites.map((s): AppMcpCandidate => ({ kind: 'site', name: slug(s.name), site: s.id, label: s.host, url: `https://${s.host}${DEFAULT_APP_MCP_PATH}`, added: hasSite(s.id) }));
    const fromProcesses = processes.flatMap((p): AppMcpCandidate[] => {
        const port = processPort(p);
        if (port === null) return [];
        const url = `http://127.0.0.1:${port}${DEFAULT_APP_MCP_PATH}`;
        return [{ kind: 'process', name: slug(p.name), label: p.name, url, added: hasUrl(url) }];
    });
    return [...fromSites, ...fromProcesses];
}

/** A stored entry as it reads, for the person and the Deck: `shop.gen/mcp`, or its URL. */
export function appMcpAddress(entry: AppMcpEntry, sites: readonly AppSite[]): string {
    if ('url' in entry) return entry.url;
    const site = sites.find((s) => s.id === entry.site);
    return `${site?.host ?? entry.site}${entry.path}`;
}

/**
 * WHAT A SESSION IS HANDED, read at each launch: the agent's app servers that are on for it, resolved now. A stored entry
 * is checked again here (a record is a file someone could edit): what is not local, not a name Genie hands, or reserved
 * is never handed. Each one left out says why (`skipped`), for the agent's lifecycle log.
 */
export function appMcpServersFor(
    record: { readonly appMcp?: readonly AppMcpEntry[] | undefined; readonly mcpOff?: readonly string[] | undefined; readonly mcpOn?: readonly string[] | undefined },
    now: { readonly sites: readonly AppSite[]; readonly routes: readonly AppRoute[]; readonly trusted: boolean; readonly workspaceOff?: readonly string[] },
): { servers: AppMcpServer[]; skipped: { name: string; reason: string }[] } {
    const entries = record.appMcp ?? [];
    if (!now.trusted) return { servers: [], skipped: entries.map((e) => ({ name: String(e.name), reason: APP_MCP_WORDS.untrusted })) };
    const off = new Set(mcpOffFor(record, now.workspaceOff ?? []));
    const servers: AppMcpServer[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const entry of entries) {
        const name = typeof entry?.name === 'string' ? entry.name : '';
        if (nameRefusal(name) !== null || servers.some((s) => s.name === name)) { skipped.push({ name, reason: APP_MCP_WORDS.invalid }); continue; }
        if (off.has(name)) continue;
        if ('site' in entry) {
            if (typeof entry.path !== 'string' || !PATH.test(entry.path)) { skipped.push({ name, reason: APP_MCP_WORDS.invalid }); continue; }
            const site = now.sites.find((s) => s.id === entry.site);
            if (!site) { skipped.push({ name, reason: APP_MCP_WORDS.siteGone }); continue; }
            const route = now.routes.find((r) => r.host === site.host);
            if (!route || !/^127\.0\.0\.1:\d+$/.test(route.target)) { skipped.push({ name, reason: APP_MCP_WORDS.notRunning(site.host) }); continue; }
            servers.push({ type: 'http', name, url: `http://${route.target}${entry.path}`, headers: [] });
            continue;
        }
        const url = typeof entry.url === 'string' ? loopbackUrl(entry.url) : null;
        if (url === null || url === 'secret' || !LOOPBACK.has(url.hostname.toLowerCase()) || url.port === '' || !PATH.test(url.pathname)) { skipped.push({ name, reason: APP_MCP_WORDS.invalid }); continue; }
        servers.push({ type: 'http', name, url: `${url.protocol}//${url.host}${url.pathname}`, headers: [] });
    }
    return { servers, skipped };
}
