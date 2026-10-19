import { formatRoute, parseRoute, type Route } from './route.js';

/**
 * GENIE'S ADDRESSES: genie://{workstation}/{workspace-slug}/{tab} (the owner, 2026-10-19: "this whole address is wrong. it
 * should be genie://{workstation}/{workspace-slug}/{tab}"; the grammar approved in q_6ac7e66d):
 *
 * ```
 * genie://alphar/tynn-ai                      a workspace — its Dashboard (…/dashboard says the same)
 * genie://alphar/tynn-ai/settings             its Settings; …/github, …/terminals; a designed tab by its slug (…/ops-board)
 * genie://alphar/tynn-ai/atlas                an agent's tab; its own sub-tab after it (…/atlas/changes)
 * genie://alphar/tynn-ai/@dashboard           an agent whose NAME is a tab word
 * genie://alphar/genie                        genie's own agent
 * genie://alphar/dashboard | deck | hosting | settings/{section} | knowledge | flows | toolchain | inbox | browser
 * …/tynn-ai/dashboard?files=src/a.ts&line=42  the file panel: a query, because it is a panel and not a tab
 * ```
 *
 * No `chat=` anywhere (the chat follows the view), no ULIDs. The app keeps its INTERNAL routes (ids; core/route.ts) —
 * this is the translation at the edge: what the hash holds and the title bar shows. An internal route Genie cannot name
 * yet (an unknown id, the snapshot not read) is left as it is, never written as a wrong address; an OLD address
 * (`genie://workspace/<id>…`) is understood as it is, and the app rewrites it.
 */

export interface AddressWorkspace {
    readonly id: string;
    readonly name?: string | undefined;
    readonly path: string;
}
export interface AddressAgent {
    readonly id: string;
    readonly name: string;
    readonly workspaceId: string;
}
export interface AddressContext {
    /** This window's workstation — the machine it is connected to (a remote host's window: that host's name). */
    readonly workstation: string;
    readonly workspaces: readonly AddressWorkspace[];
    readonly agents: readonly AddressAgent[];
    /** A workspace's designed tabs (its `workspace_tabs` setting), when known. */
    readonly tabsOf?: ((workspaceId: string) => ReadonlyArray<{ id: string; name: string }> | undefined) | undefined;
}

const OS_WORKSPACE = '__genie__';
/** The words after the workstation that are pages, not workspaces. */
const PAGES = ['dashboard', 'deck', 'hosting', 'settings', 'knowledge', 'flows', 'toolchain', 'inbox', 'browser', 'takeover', 'genie'] as const;
/** The words after a workspace that are its tabs (and its popped-out file window), not agents or designed tabs. */
const TABS = ['dashboard', 'settings', 'github', 'terminals', 'files'] as const;
/** The old heads (`genie://workspace/<id>`…): an address that starts with one is read as it is. */
const OLD_HEADS = ['dashboard', 'deck', 'agent', 'workspace', 'takeover', 'files', 'settings', 'browser', 'hosting', 'knowledge', 'flows', 'toolchain', 'inbox'];
const AGENT_TABS = ['stream', 'files', 'changes', 'shells', 'terminal', 'activity', 'settings'];

/** Whether a string is an INTERNAL route (the old address form): `genie://workspace/<id>…`, `genie://dashboard`… */
export function isInternalRoute(s: string): boolean {
    return /^genie:\/\/([a-z]+)(\/|\?|$)/.test(s) && OLD_HEADS.includes(/^genie:\/\/([a-z]+)/.exec(s)![1]!);
}

/** `Tynn.ai` → `tynn-ai`; nothing nameable → `workspace`. */
export function slugify(name: string): string {
    return name.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

const folderOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** A unique slug per workspace, in list order: never a page word, a repeat gets -2, -3… */
export function slugsFor(workspaces: readonly AddressWorkspace[]): Map<string, string> {
    const taken = new Set<string>(PAGES);
    const out = new Map<string, string>();
    for (const w of workspaces) {
        const base = slugify(w.name ?? folderOf(w.path));
        let slug = base;
        for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
        taken.add(slug);
        out.set(w.id, slug);
    }
    return out;
}

/** A workspace's designed tabs by slug (unique, never a tab word or an agent's name there). */
function tabSlugs(ctx: AddressContext, workspaceId: string): Map<string, string> {
    const taken = new Set<string>([...TABS, ...ctx.agents.filter((a) => a.workspaceId === workspaceId).map((a) => a.name)]);
    const out = new Map<string, string>();
    for (const t of ctx.tabsOf?.(workspaceId) ?? []) {
        const base = slugify(t.name);
        let slug = base;
        for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
        taken.add(slug);
        out.set(t.id, slug);
    }
    return out;
}

/** An agent's segment: its name, or `@name` when the name is a tab word or a designed tab's slug there. */
function agentSegment(ctx: AddressContext, agent: AddressAgent): string {
    const designed = new Set(tabSlugs(ctx, agent.workspaceId).values());
    return (TABS as readonly string[]).includes(agent.name) || designed.has(agent.name) ? `@${agent.name}` : agent.name;
}

function withQuery(path: string, params: URLSearchParams): string {
    const q = params.toString();
    return q ? `genie://${path}?${q}` : `genie://${path}`;
}

/** The internal route as its address; left as it is when Genie cannot name it. */
export function addressOf(internal: string, ctx: AddressContext): string {
    const r: Route = parseRoute(internal);
    const ws = ctx.workstation;
    const params = new URLSearchParams();
    switch (r.surface) {
        case 'workspace': {
            const slug = slugsFor(ctx.workspaces).get(r.workspaceId);
            if (!slug) return internal;
            let tab = 'dashboard';
            if (r.view === 'settings' || r.view === 'github' || r.view === 'terminals') tab = r.view;
            else if (r.view.startsWith('tab:')) {
                const designed = tabSlugs(ctx, r.workspaceId).get(r.view.slice(4));
                if (!designed) return internal;
                tab = designed;
            }
            if (r.panel === 'files') {
                params.set('files', r.detached ? 'detached' : r.file ?? '');
                if (r.filter === 'changed' && !r.detached) params.set('filter', 'changed');
                if (r.file && r.line !== null && !r.detached) params.set('line', String(r.line));
            }
            return withQuery(`${ws}/${slug}/${tab}`, params);
        }
        case 'files': {
            const slug = slugsFor(ctx.workspaces).get(r.workspaceId);
            return slug ? `genie://${ws}/${slug}/files` : internal;
        }
        case 'agent': {
            const agent = ctx.agents.find((a) => a.id === r.agentId || a.name === r.agentId);
            if (!agent) return internal;
            if (r.lane) params.set('lane', r.lane);
            const range = new URLSearchParams(formatRoute(r).split('?')[1] ?? '').get('range');
            if (range) params.set('range', range);
            if (r.at) params.set('at', r.at);
            if (r.layout === 'turns') params.set('layout', 'turns');
            const sub = r.tab === 'stream' ? '' : `/${r.tab}`;
            if (agent.workspaceId === OS_WORKSPACE) return withQuery(`${ws}/genie${sub}`, params);
            const slug = slugsFor(ctx.workspaces).get(agent.workspaceId);
            if (!slug) return internal;
            return withQuery(`${ws}/${slug}/${agentSegment(ctx, agent)}${sub}`, params);
        }
        case 'dashboard':
            if (r.group === 'status') params.set('group', 'status');
            return withQuery(`${ws}/dashboard`, params);
        case 'deck':
            if (r.item) params.set('item', r.item);
            return withQuery(`${ws}/deck`, params);
        case 'hosting':
            if (r.tab) params.set('tab', r.tab);
            return withQuery(`${ws}/hosting`, params);
        case 'settings':
            return `genie://${ws}/settings${r.section ? `/${r.section}` : ''}`;
        case 'browser':
            if (r.url) params.set('url', r.url);
            return withQuery(`${ws}/browser`, params);
        case 'takeover':
            if (r.login) params.set('login', r.login);
            return withQuery(`${ws}/takeover/${r.terminalId}`, params);
        default:
            return `genie://${ws}/${r.surface}`;
    }
}

/** The address as the internal route; an OLD address as it is; `null` when it names nothing here. */
export function routeOfAddress(address: string, ctx: AddressContext): string | null {
    const m = /^genie:\/\/([^?]*)(?:\?(.*))?$/.exec(address.trim());
    if (!m) return null;
    const segs = (m[1] ?? '').split('/').filter(Boolean);
    const query = m[2] ?? '';
    const params = new URLSearchParams(query);
    const [first, second, third, fourth] = segs;
    if (first === undefined) return null;
    if (first.toLowerCase() !== ctx.workstation.toLowerCase()) {
        return OLD_HEADS.includes(first) ? address.trim() : null;
    }
    const keep = (names: readonly string[]): URLSearchParams => {
        const out = new URLSearchParams();
        for (const n of names) { const v = params.get(n); if (v !== null) out.set(n, v); }
        return out;
    };
    const q = (p: URLSearchParams): string => (p.toString() ? `?${p.toString()}` : '');
    const agentRoute = (agent: AddressAgent, tab: string | undefined): string | null => {
        if (tab !== undefined && !AGENT_TABS.includes(tab)) return null;
        const p = new URLSearchParams({ tab: tab ?? 'stream' });
        for (const n of ['lane', 'range', 'at', 'layout']) { const v = params.get(n); if (v !== null) p.set(n, v); }
        return `genie://agent/${agent.id}?${p.toString()}`;
    };
    if (second === undefined) return null;
    switch (second) {
        case 'dashboard': return `genie://dashboard?group=${params.get('group') === 'status' ? 'status' : 'workspace'}`;
        case 'deck': return `genie://deck${q(keep(['item']))}`;
        case 'hosting': return `genie://hosting${q(keep(['tab']))}`;
        case 'settings': return third ? `genie://settings/${third}` : 'genie://settings';
        case 'browser': return `genie://browser${q(keep(['url']))}`;
        case 'takeover': return third ? `genie://takeover/${third}${q(keep(['login']))}` : null;
        case 'knowledge': case 'flows': case 'toolchain': case 'inbox': return `genie://${second}`;
        case 'genie': {
            const os = ctx.agents.find((a) => a.workspaceId === OS_WORKSPACE && a.name === 'genie');
            return os ? agentRoute(os, third) : agentRoute({ id: 'genie', name: 'genie', workspaceId: OS_WORKSPACE }, third);
        }
    }
    const workspaceId = [...slugsFor(ctx.workspaces)].find(([, slug]) => slug === second)?.[0];
    if (!workspaceId) return null;
    const wsQuery = q(keep(['files', 'filter', 'line']));
    if (third === undefined || third === 'dashboard') return `genie://workspace/${workspaceId}${wsQuery}`;
    if (third === 'settings' || third === 'github' || third === 'terminals') {
        const p = keep(['files', 'filter', 'line']);
        p.set('view', third);
        return `genie://workspace/${workspaceId}?${p.toString()}`;
    }
    if (third === 'files') return `genie://files/${workspaceId}`;
    const designed = [...tabSlugs(ctx, workspaceId)].find(([, slug]) => slug === third)?.[0];
    if (designed) {
        const p = keep(['files', 'filter', 'line']);
        p.set('view', `tab:${designed}`);
        return `genie://workspace/${workspaceId}?${p.toString()}`;
    }
    const name = third.startsWith('@') ? third.slice(1) : third;
    const agent = ctx.agents.find((a) => a.workspaceId === workspaceId && a.name === name);
    if (agent) return agentRoute(agent, fourth);
    // Its designed tabs not read yet: the workspace, until they are (the same address then resolves to the tab).
    if (!third.startsWith('@') && fourth === undefined && ctx.tabsOf?.(workspaceId) === undefined) return `genie://workspace/${workspaceId}`;
    return null;
}
