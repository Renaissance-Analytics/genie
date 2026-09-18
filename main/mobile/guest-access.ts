import type http from 'node:http';
import { Readable } from 'node:stream';

import { getWorkspaceAgentById } from '../agents/lookup';
import {
    policyAllowsSite,
    visibleWorkspaceIds,
    type HostAccessPolicy,
} from '../host-core/access-policy';
import { workspaceOfListItem } from '../lists/wiring';
import type { MobileDataDeps } from './api';

/**
 * What a GUEST may do on this host — someone the workstation was SHARED with,
 * connected over the relay with a grant that names what they may reach.
 *
 * WHY THIS EXISTS (genie-cloud#33). Genie's member-facing server authenticated
 * sessions and judged none of them: `host-core/access-policy.ts` was never called,
 * and a relay host proxied every member through one owner session. The only scope
 * check anywhere was a `workspaceId` TAG the member wrote on its own frames, which
 * a REST call never carried and a terminal open could set to anything. A share
 * that named one workspace therefore reached them all.
 *
 * THE RULE. A guest's request is judged by the RESOURCE it reaches, resolved here
 * from the host's own data — the terminal's workspace, the process's, the file
 * root's, the question's, the list item's, the agent's, the site's — never by
 * anything the request asserts about itself.
 *
 *  - DEFAULT DENY. A route the table below does not name is refused, so a route
 *    added later is closed to guests until someone decides otherwise.
 *  - INVISIBLE, NOT REFUSED. A target outside the grant answers exactly like one
 *    that does not exist (404 "unknown workspace"), and every listing is narrowed,
 *    so a guest never learns the names of the owner's other work (spec §3.1).
 *  - HOST MANAGEMENT IS NOT SHARED. Genie's settings, the updater, plugins, Tynn
 *    provisioning, AgentInbox (it speaks AS the owner), Workstation Setup, session
 *    save, the host clipboard, machine-wide services: none of it is in the table.
 *  - READ-ONLY CHANGES NOTHING. Every write is refused before it reaches a handler.
 *  - `control` INCLUDES HOSTING CONTROLS for the workspace's own sites and
 *    processes — start, stop, restart, logs — and not their configuration
 *    (owner decision, spec §7 Q1).
 *
 * The owner's own paired devices never reach this module: a session without an
 * `access` policy is not a guest.
 */

/** A route that is not part of what a guest was given. */
export const GUEST_NOT_GRANTED = 'Not part of the access you were given.';
/** A write from a read-only guest. */
export const GUEST_READ_ONLY = 'Read-only access cannot change anything.';

/** Uploads carry base64 bodies; the handlers enforce their own tighter caps. */
const GUEST_BODY_CAP = Math.ceil(25 * 1024 * 1024 * 1.4) + 1024;

type Json = Record<string, unknown>;

/** The workspaces this guest reaches on this host — the one set every rule reads. */
export class GuestScope {
    readonly visible: Set<string>;
    /** The policy with its workspace scopes written in this host's own ids. */
    readonly servedPolicy: HostAccessPolicy;
    private readonly byPath: Map<string, string>;

    constructor(
        readonly policy: HostAccessPolicy,
        readonly deps: MobileDataDeps,
    ) {
        // The SERVED workspaces only (`listWorkspaces` excludes the protected System
        // Workspace), so no grant — not even `host:all` — reaches the operator's.
        const served = deps.listWorkspaces();
        this.visible = visibleWorkspaceIds(policy, served.map((w) => w.id), deps.workspaceTynnProjectId);
        this.servedPolicy = policy.workspaceScopes.includes('host:all')
            ? policy
            : { ...policy, workspaceScopes: [...this.visible].map((id) => `workspace:${id}` as const) };
        this.byPath = new Map(served.map((w) => [w.path, w.id]));
    }

    has(workspaceId: string | null | undefined): boolean {
        return !!workspaceId && this.visible.has(workspaceId);
    }

    /** The workspace id at a host path (the files routes address workspaces by path). */
    workspaceAtPath(p: unknown): string | null {
        return typeof p === 'string' ? (this.byPath.get(p) ?? null) : null;
    }

    terminalWorkspace(id: unknown): string | null {
        const spec = this.deps.listTerminalSpecs().find((s) => s.id === String(id ?? ''));
        return spec?.workspace_id ?? null;
    }

    processWorkspace(id: unknown): string | null {
        const proc = this.deps.listAllProcesses().find((p) => p.id === String(id ?? ''));
        return proc?.workspaceId ?? null;
    }

    questionWorkspace(id: unknown): string | null {
        const q = this.deps.listPendingQuestions().find((x) => x.id === String(id ?? ''));
        return this.workspaceAtPath(q?.workspacePath);
    }

    /** A process OR terminal spec (a schedule is keyed by the spec that runs it). */
    specWorkspace(id: string): string | null {
        return this.processWorkspace(id) ?? this.terminalWorkspace(id);
    }

    siteGranted(site: { workspaceId: string; siteId: string }): boolean {
        return (
            this.has(site.workspaceId) &&
            policyAllowsSite(this.servedPolicy, { workspaceId: site.workspaceId, siteId: site.siteId }).allowed
        );
    }
}

/** What a guest request aims at. */
type Target =
    /** Nothing workspace-bound (the baton, the container runtime probe). */
    | { kind: 'host' }
    /** Every listed workspace must be in scope; a null is an unresolvable target. */
    | { kind: 'workspaces'; ids: Array<string | null> }
    /** Not something a guest may do, whatever the workspace. */
    | { kind: 'deny' };

interface GuestRequest {
    scope: GuestScope;
    body: Json;
    query: URLSearchParams;
    match: RegExpExecArray;
}

interface GuestRoute {
    method: 'GET' | 'POST';
    path: RegExp;
    /** Changes something: refused for read-only guests. */
    write: boolean | ((r: GuestRequest) => boolean);
    target: (r: GuestRequest) => Target;
    /** Narrows a listing response to what the guest reaches. */
    filter?: (json: Json, scope: GuestScope) => Json;
    /** The route reads a JSON body the gate must see first. */
    body?: boolean;
}

const ws = (...ids: Array<string | null>): Target => ({ kind: 'workspaces', ids });
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const exact = (p: string): RegExp => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** Site actions a guest may take: reading, and the hosting controls (Q1). */
const SITE_READS = new Set(['list', 'detect', 'status', 'logs']);
const SITE_HOSTING_CONTROLS = new Set(['start', 'stop', 'restart']);

/** AgentInbox reach a guest may give an agent: nothing beyond the workspace. */
function agentReachAllowed(scope: GuestScope, reach: unknown, workspaces: unknown): boolean {
    if (reach === undefined || reach === 'none' || reach === 'self' || reach === 'hidden') return true;
    if (reach === 'specific') {
        return Array.isArray(workspaces) && workspaces.every((id) => scope.has(String(id)));
    }
    return false; // 'all', or anything unrecognised
}

function filterArray(json: Json, key: string, keep: (item: Json) => boolean): Json {
    const list = json[key];
    return Array.isArray(list) ? { ...json, [key]: list.filter((item) => keep(obj(item))) } : json;
}

function filterRecord(record: unknown, keep: (id: string) => boolean): Json {
    return Object.fromEntries(Object.entries(obj(record)).filter(([id]) => keep(id)));
}

const GUEST_ROUTES: GuestRoute[] = [
    // --- the baton (a guest takes turns; baton.ts refuses TAKING from an owner) ---
    { method: 'POST', path: /^\/api\/control\/(take|release|give)$/, write: true, target: () => ({ kind: 'host' }) },

    // --- dashboard listings, narrowed ------------------------------------------
    {
        method: 'GET',
        path: exact('/api/state'),
        write: false,
        target: () => ({ kind: 'host' }),
        filter: (json, scope) => {
            let out = filterArray(json, 'workspaces', (w) => scope.has(str(w.id)));
            out = filterArray(out, 'terminals', (t) => scope.has(str(t.workspaceId)));
            out = filterArray(out, 'processes', (p) => scope.has(str(p.workspaceId)));
            return filterArray(out, 'questions', (q) => scope.has(scope.workspaceAtPath(q.workspacePath)));
        },
    },
    { method: 'GET', path: exact('/api/workspaces'), write: false, target: () => ({ kind: 'host' }), filter: (j, s) => filterArray(j, 'workspaces', (w) => s.has(str(w.id))) },
    { method: 'GET', path: exact('/api/terminals'), write: false, target: () => ({ kind: 'host' }), filter: (j, s) => filterArray(j, 'terminals', (t) => s.has(str(t.workspaceId))) },
    { method: 'GET', path: exact('/api/processes'), write: false, target: () => ({ kind: 'host' }), filter: (j, s) => filterArray(j, 'processes', (p) => s.has(str(p.workspaceId))) },
    { method: 'GET', path: exact('/api/questions'), write: false, target: () => ({ kind: 'host' }), filter: (j, s) => filterArray(j, 'questions', (q) => s.has(s.workspaceAtPath(q.workspacePath))) },
    {
        method: 'GET',
        path: exact('/api/schedules'),
        write: false,
        target: () => ({ kind: 'host' }),
        filter: (j, s) => ({ ...j, schedules: filterRecord(j.schedules, (id) => s.has(s.specWorkspace(id))) }),
    },
    {
        method: 'GET',
        path: exact('/api/sites/enabled'),
        write: false,
        target: () => ({ kind: 'host' }),
        filter: (j, s) =>
            filterArray(j, 'sites', (site) => s.siteGranted({ workspaceId: String(site.workspaceId ?? ''), siteId: String(site.siteId ?? '') })),
    },
    { method: 'GET', path: exact('/api/desktop/workspaces'), write: false, target: () => ({ kind: 'host' }), filter: (j, s) => filterArray(j, 'workspaces', (w) => s.has(str(w.id))) },
    { method: 'GET', path: exact('/api/desktop/terminal-specs'), write: false, target: () => ({ kind: 'host' }), filter: (j, s) => filterArray(j, 'specs', (sp) => s.has(str(sp.workspace_id))) },

    // --- processes, terminals, questions ---------------------------------------
    { method: 'POST', path: /^\/api\/process\/([^/]+)\/(start|stop|restart|run-now)$/, write: true, target: (r) => ws(r.scope.processWorkspace(decodeURIComponent(r.match[1]))) },
    { method: 'POST', path: exact('/api/terminal/create'), write: true, body: true, target: (r) => ws(str(r.body.workspaceId)) },
    { method: 'POST', path: exact('/api/desktop/terminal-open'), write: true, body: true, target: (r) => ws(str(r.body.workspaceId)) },
    { method: 'POST', path: /^\/api\/terminal\/([^/]+)\/kill$/, write: true, target: (r) => ws(r.scope.terminalWorkspace(decodeURIComponent(r.match[1]))) },
    { method: 'POST', path: /^\/api\/workspace\/([^/]+)\/upload$/, write: true, body: true, target: (r) => ws(decodeURIComponent(r.match[1])) },
    { method: 'POST', path: /^\/api\/questions\/([^/]+)\/answer$/, write: true, body: true, target: (r) => ws(r.scope.questionWorkspace(decodeURIComponent(r.match[1]))) },

    // --- files (addressed by the workspace's host path) -------------------------
    { method: 'POST', path: /^\/api\/files\/(tree|read|git-status)$/, write: false, body: true, target: (r) => ws(r.scope.workspaceAtPath(r.body.workspacePath)) },
    {
        method: 'POST',
        path: /^\/api\/files\/(write|create-file|create-folder|rename|duplicate|delete|import-external)$/,
        write: true,
        body: true,
        target: (r) => ws(r.scope.workspaceAtPath(r.body.workspacePath)),
    },
    { method: 'POST', path: exact('/api/plugins/editor-read'), write: false, body: true, target: (r) => ws(r.scope.workspaceAtPath(r.body.root)) },
    { method: 'POST', path: exact('/api/plugins/editor-write'), write: true, body: true, target: (r) => ws(r.scope.workspaceAtPath(r.body.root)) },

    // --- IssueWatch, lists, docs (all the workspace's own) ----------------------
    {
        method: 'GET',
        path: exact('/api/desktop/issue-watch/counts'),
        write: false,
        target: () => ({ kind: 'host' }),
        filter: (j, s) => ({ ...j, counts: filterRecord(j.counts, (id) => s.has(id)) }),
    },
    { method: 'GET', path: /^\/api\/desktop\/issue-watch\/(repos|feed|feedback-items|status)$/, write: false, target: (r) => ws(str(r.query.get('workspaceId'))) },
    { method: 'POST', path: /^\/api\/desktop\/issue-watch\/(mark-seen|force-refresh)$/, write: true, body: true, target: (r) => ws(str(r.body.workspaceId)) },
    { method: 'GET', path: exact('/api/desktop/lists/read'), write: false, target: (r) => ws(str(r.query.get('workspaceId'))) },
    { method: 'POST', path: exact('/api/desktop/lists/resolve'), write: true, body: true, target: (r) => ws(workspaceOfListItem(String(r.body.todoId ?? ''))) },
    { method: 'POST', path: exact('/api/desktop/docs/health'), write: false, body: true, target: (r) => ws(str(r.body.workspaceId)) },
    { method: 'POST', path: exact('/api/desktop/docs/repair'), write: true, body: true, target: (r) => ws(str(r.body.workspaceId)) },

    // --- hosting: the workspace's sites (not machine-wide services) -------------
    { method: 'GET', path: exact('/api/desktop/dev-server/runtime'), write: false, target: () => ({ kind: 'host' }) },
    { method: 'POST', path: exact('/api/desktop/dev-server/repos'), write: false, body: true, target: (r) => ws(str(r.body.workspaceId)) },
    {
        method: 'POST',
        path: exact('/api/desktop/dev-server/site'),
        body: true,
        write: (r) => !SITE_READS.has(String(obj(r.body.req).action ?? 'list')),
        target: (r) => {
            const action = String(obj(r.body.req).action ?? 'list');
            // Configuration (create/update/remove) and `open` — which opens a browser
            // on the HOST's own screen — are not hosting controls.
            if (!SITE_READS.has(action) && !SITE_HOSTING_CONTROLS.has(action)) return { kind: 'deny' };
            return ws(str(r.body.workspaceId));
        },
    },

    // --- terminal specs + agents ------------------------------------------------
    { method: 'POST', path: exact('/api/desktop/terminal-spec/get'), write: false, body: true, target: (r) => ws(r.scope.terminalWorkspace(r.body.id)) },
    { method: 'POST', path: exact('/api/desktop/terminal-spec/create'), write: true, body: true, target: (r) => ws(str(obj(r.body.input).workspace_id)) },
    {
        method: 'POST',
        path: exact('/api/desktop/terminal-spec/create-agent'),
        write: true,
        body: true,
        target: (r) => {
            const input = obj(r.body.input);
            const target = ws(str(input.workspace_id));
            if (!r.scope.has(str(input.workspace_id))) return target;
            // An agent a guest starts may not be given reach beyond the workspace.
            return agentReachAllowed(r.scope, input.scope, input.scope_workspaces) ? target : { kind: 'deny' };
        },
    },
    { method: 'POST', path: /^\/api\/desktop\/terminal-spec\/(restart-agent|remove|touch)$/, write: true, body: true, target: (r) => ws(r.scope.terminalWorkspace(r.body.id)) },
    {
        method: 'POST',
        path: exact('/api/desktop/terminal-spec/update'),
        write: true,
        body: true,
        target: (r) => {
            const patch = obj(r.body.patch);
            const meta = obj(patch.meta);
            const ids = [r.scope.terminalWorkspace(r.body.id)];
            // Moving a terminal is a write to BOTH workspaces.
            if (patch.workspace_id !== undefined) ids.push(str(patch.workspace_id));
            if (!ids.every((id) => r.scope.has(id))) return ws(...ids);
            return agentReachAllowed(r.scope, meta.whisper_scope, meta.whisper_workspaces) ? ws(...ids) : { kind: 'deny' };
        },
    },
    {
        method: 'POST',
        path: exact('/api/desktop/terminal-spec/reorder'),
        write: true,
        body: true,
        target: (r) => ws(...(Array.isArray(r.body.ids) ? r.body.ids : [null]).map((id) => r.scope.terminalWorkspace(id))),
    },
    { method: 'POST', path: /^\/api\/desktop\/agents\/(list|roster)$/, write: false, body: true, target: (r) => ws(str(r.body.workspaceId)) },
    { method: 'POST', path: /^\/api\/desktop\/agents\/(adopt|start)$/, write: true, body: true, target: (r) => ws(str(r.body.workspaceId)) },
    { method: 'POST', path: exact('/api/desktop/agents/create'), write: true, body: true, target: (r) => ws(str(obj(r.body.input).workspaceId)) },
    {
        method: 'POST',
        path: /^\/api\/desktop\/agents\/(stop|delete|add-runtime|front|set-avatar)$/,
        write: true,
        body: true,
        target: (r) => ws(getWorkspaceAgentById(String(r.body.agentId ?? ''))?.workspace_id ?? null),
    },
    {
        method: 'POST',
        path: exact('/api/desktop/agents/set-default'),
        write: true,
        body: true,
        target: (r) =>
            r.body.agentId == null
                ? ws(str(r.body.workspaceId))
                : ws(str(r.body.workspaceId), getWorkspaceAgentById(String(r.body.agentId))?.workspace_id ?? null),
    },
];

function readRaw(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer | string) => {
            const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
            size += chunk.length;
            if (size > GUEST_BODY_CAP) {
                reject(new Error('payload too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** A request whose body the gate already consumed, readable again by the handler. */
function replay(req: http.IncomingMessage, raw: Buffer): http.IncomingMessage {
    const again = Readable.from(raw.length ? [raw] : []) as unknown as http.IncomingMessage;
    return Object.assign(again, { method: req.method, url: req.url, headers: req.headers, socket: req.socket });
}

/**
 * A response that narrows a successful JSON listing before it is written. The
 * handlers write through `writeHead` + `end` (api.ts `sendJson`); anything else is
 * passed straight through to the real response.
 */
function filtering(res: http.ServerResponse, transform: (json: Json) => Json): http.ServerResponse {
    let status = 0;
    let headers: http.OutgoingHttpHeaders = {};
    return new Proxy(res, {
        get(target, prop) {
            if (prop === 'writeHead') {
                return (s: number, h?: http.OutgoingHttpHeaders) => {
                    status = s;
                    headers = h ?? {};
                    return target;
                };
            }
            if (prop === 'end') {
                return (data?: string) => {
                    let out = data;
                    if (status >= 200 && status < 300 && typeof data === 'string') {
                        try {
                            out = JSON.stringify(transform(JSON.parse(data) as Json));
                        } catch {
                            // Not JSON we can narrow: never hand it to a guest unnarrowed.
                            status = 403;
                            out = JSON.stringify({ error: GUEST_NOT_GRANTED });
                        }
                    }
                    const body = out ?? '';
                    target.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) });
                    target.end(body);
                    return target;
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function refuse(res: http.ServerResponse, status: number, error: string): void {
    const body = JSON.stringify({ error });
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

export type GuestGate =
    | { refused: true }
    | { refused: false; req: http.IncomingMessage; res: http.ServerResponse };

/**
 * Judge one `/api/*` request from a guest session. Refuses (and answers) what the
 * guest may not do; otherwise hands back a request the handler can still read and
 * a response that narrows listings to the guest's scope.
 */
export async function gateGuestApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    deps: MobileDataDeps,
    policy: HostAccessPolicy,
): Promise<GuestGate> {
    const method = (req.method ?? 'GET').toUpperCase();
    let route: GuestRoute | null = null;
    let match: RegExpExecArray | null = null;
    for (const candidate of GUEST_ROUTES) {
        if (candidate.method !== method) continue;
        match = candidate.path.exec(pathname);
        if (match) {
            route = candidate;
            break;
        }
    }
    if (!route || !match) {
        refuse(res, 403, GUEST_NOT_GRANTED);
        return { refused: true };
    }

    let raw: Buffer = Buffer.alloc(0);
    let body: Json = {};
    if (route.body) {
        try {
            raw = await readRaw(req);
            body = raw.length ? obj(JSON.parse(raw.toString('utf8'))) : {};
        } catch {
            // Unreadable body: nothing resolves, so a workspace-bound route refuses.
            body = {};
        }
    }

    const scope = new GuestScope(policy, deps);
    const query = new URL(req.url ?? pathname, 'http://guest.invalid').searchParams;
    const request: GuestRequest = { scope, body, query, match };
    const target = route.target(request);

    if (target.kind === 'deny') {
        refuse(res, 403, GUEST_NOT_GRANTED);
        return { refused: true };
    }
    // Out of scope answers like nonexistent — checked BEFORE capability, so a
    // read-only guest cannot probe for the owner's other workspaces either.
    if (target.kind === 'workspaces' && (target.ids.length === 0 || !target.ids.every((id) => scope.has(id)))) {
        refuse(res, 404, 'unknown workspace');
        return { refused: true };
    }
    const write = typeof route.write === 'function' ? route.write(request) : route.write;
    if (write && policy.capability !== 'control') {
        refuse(res, 403, GUEST_READ_ONLY);
        return { refused: true };
    }

    return {
        refused: false,
        req: route.body ? replay(req, raw) : req,
        res: route.filter ? filtering(res, (json) => route.filter!(json, scope)) : res,
    };
}

/**
 * Whether a guest may attach to a terminal over `/ws/term`: only one belonging to
 * a workspace they reach. Judged on the terminal's own workspace — never on a tag
 * the client sent.
 */
export function guestMayAttachTerminal(policy: HostAccessPolicy, deps: MobileDataDeps, terminalId: string): boolean {
    const scope = new GuestScope(policy, deps);
    return scope.has(scope.terminalWorkspace(terminalId));
}

/**
 * Whether a guest may reach a `.gen` site through the site proxy: the site's
 * workspace is in scope, the grant names the site, and a non-safe method or a
 * WebSocket needs `interact` plus `control`.
 */
export function guestMayUseSite(
    policy: HostAccessPolicy,
    deps: MobileDataDeps,
    site: { workspaceId: string; siteId: string },
    request: { method?: string; websocket?: boolean },
): boolean {
    const scope = new GuestScope(policy, deps);
    if (!scope.has(site.workspaceId)) return false;
    const decision = policyAllowsSite(scope.servedPolicy, { ...site, ...request });
    if (!decision.allowed) return false;
    const interactive = request.websocket === true || !['GET', 'HEAD', 'OPTIONS'].includes((request.method ?? 'GET').toUpperCase());
    return !interactive || policy.capability === 'control';
}

/**
 * The `/ws/events` payload a guest socket receives for one push, or undefined to
 * withhold it. Default deny: an event type not named here is not sent to a guest.
 */
export function guestEventPayload(
    policy: HostAccessPolicy,
    deps: MobileDataDeps,
    type: string,
    payload: unknown,
): unknown {
    const scope = new GuestScope(policy, deps);
    const p = obj(payload);
    switch (type) {
        // Re-fetch nudges with no payload: the re-fetch goes through the narrowed REST.
        case 'workspaces:changed':
        case 'terminal-spec:changed':
        case 'agents:changed':
        case 'dev-server:changed':
            return payload;
        // Per recipient already (baton.ts) — who is connected and who drives.
        case 'control:changed':
            return payload;
        case 'process:status':
        case 'schedule:next':
            return scope.has(scope.specWorkspace(String(p.id ?? ''))) ? payload : undefined;
        case 'terminal:attention':
            return scope.has(scope.terminalWorkspace(p.id)) ? payload : undefined;
        case 'workspace:pulse':
        case 'lists:changed':
        case 'agent-pulse':
        case 'agent:thumbs-up':
        case 'notify:imdone':
            return scope.has(str(p.workspaceId)) ? payload : undefined;
        case 'dev-server:site-progress':
            return scope.has(str(p.workspaceId)) ? payload : undefined;
        case 'issue-watch:update':
            return {
                ...p,
                counts: filterRecord(p.counts, (id) => scope.has(id)),
                errors: filterRecord(p.errors, (id) => scope.has(id)),
            };
        case 'questions:changed': {
            const mine = deps.listPendingQuestions().filter((q) => scope.has(scope.workspaceAtPath(q.workspacePath)));
            return { count: mine.length, workspaces: new Set(mine.map((q) => q.workspacePath)).size };
        }
        default:
            return undefined;
    }
}
