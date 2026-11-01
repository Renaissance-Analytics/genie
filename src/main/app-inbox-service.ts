import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    APP_LIMITS,
    AppRateLimiter,
    appDelivery,
    appSenderId,
    appSenderLabel,
    appTarget,
    isAppSender,
    parseAppMessage,
    type AppSource,
} from '../core/app-inbox.js';
import type { AgentRecord } from '../core/identity.js';
import { agentAddress } from '../core/inbox.js';
import type { AppInboxKeys } from './app-inbox-keys.js';
import type { InboxMessage, InboxStore } from './inbox-store.js';

/**
 * THE APP DOOR (genie#1345): how a Genie-hosted site, a kept process or a script outside Genie reports to an agent.
 *
 *     POST /v1/inbox              { to?, subject, body, level?, link?, dedupeKey? }  → 201 { messageId, to, delivery }
 *     GET  /v1/inbox/<messageId>  its own message's receipt                          → 200 { readAt, … }
 *     GET  /v1/agents             the addresses it may write to                       → 200 { agents }
 *     Authorization: Bearer <GENIE_INBOX_TOKEN>
 *
 * A loopback listener of its own — never Genie's MCP server, whose one bearer is in every terminal and every workspace's
 * agent config (MCP is for agents; this is an API for apps, the owner's rule). The rules, in the order they are applied:
 *
 * 1. NOT A BROWSER. Any `Origin` header is refused, and the `Host` must be this loopback address: a web page — the
 *    site's own front end, or any page the person visits — cannot reach it, and DNS rebinding cannot either.
 * 2. WHO IS ASKING is the credential, and only the credential (AppInboxKeys): unknown, rotated or revoked is 404 — the
 *    same answer as a route that is not there, so the door does not confirm what exists.
 * 3. THE WORKSPACE'S SWITCH ("Apps and scripts may message agents here") is on.
 * 4. WHERE: an agent of the credential's own workspace (core/app-inbox.ts appTarget).
 * 5. HOW MUCH: a repeated dedupeKey stores nothing; an agent's uncollected app mail is capped; each credential has a
 *    burst and a day cap. A refusal stores nothing.
 */

/** The door's first-choice port, so a script outside Genie has a stable address; taken, Genie remembers the one it got. */
export const APP_INBOX_PORT = 47432;

export interface AppEnvSource {
    readonly kind: 'site' | 'process';
    readonly id: string;
    readonly name: string;
    readonly workspaceId: string;
}

/** The two variables a site or process starts with — or none, when it holds no token (revoked, switched off) or the door is not listening. */
export function appInboxEnvFor(input: { readonly url: string | null; readonly token: string | null }): Record<string, string> {
    return input.url && input.token ? { GENIE_INBOX_URL: input.url, GENIE_INBOX_TOKEN: input.token } : {};
}

export interface AppInboxRequest {
    readonly method: string;
    readonly path: string;
    /** The port this listener is on: the only `Host` it answers. */
    readonly port: number;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body: string;
}

export interface AppInboxResponse {
    readonly status: number;
    readonly body: Record<string, unknown>;
    readonly headers?: Readonly<Record<string, string>>;
}

export interface AppInboxServiceDeps {
    readonly keys: Pick<AppInboxKeys, 'resolve' | 'used'>;
    readonly inbox: Pick<InboxStore, 'send' | 'unread' | 'all'>;
    readonly roster: () => readonly AgentRecord[];
    readonly slugs?: () => ReadonlyMap<string, string>;
    readonly defaultAgentOf?: (workspaceId: string) => string | null;
    /** The workspace's "Apps and scripts may message agents here" (setting `app_inbox`, on by default). */
    readonly enabled: (workspaceId: string) => boolean;
    /** The workspace's own `.gen` hosts: the only places a message's `link` may point. */
    readonly siteHosts: (workspaceId: string) => readonly string[];
    readonly now?: () => number;
    readonly log?: (line: string) => void;
}

const NOT_FOUND: AppInboxResponse = { status: 404, body: { ok: false, error: 'not found' } };
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): AppInboxResponse =>
    ({ status, body: { ok: false, error, ...extra }, ...(headers ? { headers } : {}) });

export class AppInboxService {
    readonly #deps: AppInboxServiceDeps;
    readonly #now: () => number;
    readonly #limiter: AppRateLimiter;
    readonly #dedupe = new Map<string, { messageId: string; to: string; at: number }>();

    constructor(deps: AppInboxServiceDeps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#limiter = new AppRateLimiter(this.#now);
    }

    async handle(req: AppInboxRequest): Promise<AppInboxResponse> {
        const h = (name: string): string | undefined => req.headers[name] ?? undefined;
        // 1. Not a browser, and only at this address.
        if (h('origin') !== undefined) return refuse(403, 'browsers may not call this: post from your server, process or script');
        const host = (h('host') ?? '').toLowerCase();
        if (host !== `127.0.0.1:${req.port}` && host !== `localhost:${req.port}`) return refuse(403, 'this endpoint answers only on its loopback address');
        const path = req.path.split('?')[0] ?? '';
        const route = path === '/v1/inbox' && req.method === 'POST' ? 'send'
            : path === '/v1/agents' && req.method === 'GET' ? 'agents'
            : /^\/v1\/inbox\/[A-Za-z0-9_-]{1,100}$/.test(path) && req.method === 'GET' ? 'receipt'
            : null;
        if (route === null) return NOT_FOUND;
        // 2. Who.
        const auth = h('authorization') ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
        const source = token ? this.#deps.keys.resolve(token) : null;
        if (!source) return NOT_FOUND;
        // 3. Switched on here.
        if (!this.#deps.enabled(source.workspaceId)) return refuse(403, 'apps and scripts may not message agents in this workspace (its Settings)');
        if (route === 'agents') return this.#agents(source);
        if (route === 'receipt') return this.#receipt(source, path.slice('/v1/inbox/'.length));
        return this.#send(source, req);
    }

    #slugs(): ReadonlyMap<string, string> {
        return this.#deps.slugs?.() ?? new Map<string, string>();
    }

    #agents(source: AppSource): AppInboxResponse {
        const slugs = this.#slugs();
        const def = this.#deps.defaultAgentOf?.(source.workspaceId) ?? null;
        const agents = this.#deps.roster()
            .filter((r) => r.workspaceId === source.workspaceId && r.accessScope !== 'none' && appTarget(r.id, this.#deps.roster(), source.workspaceId, { slugs }).kind === 'one')
            .map((r) => ({ address: agentAddress(r, slugs), name: r.name, default: r.id === def }));
        return { status: 200, body: { ok: true, agents } };
    }

    #receipt(source: AppSource, messageId: string): AppInboxResponse {
        const from = appSenderId(source);
        const m = this.#deps.inbox.all().find((x) => x.id === messageId && x.from === from);
        if (!m) return NOT_FOUND;
        const record = this.#deps.roster().find((r) => r.id === m.to);
        return { status: 200, body: { ok: true, messageId: m.id, to: record ? agentAddress(record, this.#slugs()) : m.to, sentAt: m.sentAt, readAt: m.readAt } };
    }

    async #send(source: AppSource, req: AppInboxRequest): Promise<AppInboxResponse> {
        const type = (req.headers['content-type'] ?? '').toLowerCase();
        if (!/^application\/json\s*(;|$)/.test(type)) return refuse(415, 'send JSON: Content-Type: application/json');
        if (Buffer.byteLength(req.body, 'utf8') > APP_LIMITS.requestBytes) return refuse(413, `a request is at most ${APP_LIMITS.requestBytes} bytes`);
        let raw: unknown;
        try { raw = JSON.parse(req.body); } catch { return refuse(400, 'the body is not JSON'); }
        const parsed = parseAppMessage(raw, { siteHosts: this.#deps.siteHosts(source.workspaceId).map((x) => x.toLowerCase()) });
        if (!parsed.ok) return refuse(parsed.status, parsed.error);
        const msg = parsed.value;
        const slugs = this.#slugs();
        const target = appTarget(msg.to, this.#deps.roster(), source.workspaceId, { slugs, defaultAgentId: this.#deps.defaultAgentOf?.(source.workspaceId) ?? null });
        if (target.kind === 'refused') return refuse(target.status, target.error);
        const record = target.record;
        const from = appSenderId(source);
        const now = this.#now();
        // 5. How much — nothing below spends or stores on a refusal.
        if (msg.dedupeKey !== undefined) {
            const key = `${from}|${msg.dedupeKey}`;
            const seen = this.#dedupe.get(key);
            if (seen && now - seen.at < APP_LIMITS.dedupeMs) return { status: 200, body: { ok: true, messageId: seen.messageId, to: seen.to, deduplicated: true } };
        }
        const backlog = this.#deps.inbox.unread(record.id).filter((m) => isAppSender(m.from)).length;
        if (backlog >= APP_LIMITS.backlog) {
            return refuse(429, `${record.name} has ${backlog} uncollected app messages; nothing more is taken until it collects them`, { retryAfterMs: APP_LIMITS.refillMs }, { 'retry-after': String(Math.ceil(APP_LIMITS.refillMs / 1000)) });
        }
        const allowed = this.#limiter.take(from);
        if (!allowed.ok) {
            return refuse(429, allowed.reason === 'daily' ? `this ${source.kind} has sent its ${APP_LIMITS.perDay} messages for the day` : 'too many messages at once; slow down', { retryAfterMs: allowed.retryAfterMs }, { 'retry-after': String(Math.max(1, Math.ceil(allowed.retryAfterMs / 1000))) });
        }
        const label = appSenderLabel(source, slugs.get(source.workspaceId) ?? source.workspaceId);
        let message: InboxMessage;
        try {
            message = await this.#deps.inbox.send({
                from,
                to: record.id,
                text: msg.body,
                app: { source: { kind: source.kind, id: source.id, name: source.name, workspaceId: source.workspaceId }, label, subject: msg.subject, level: msg.level, ...(msg.link ? { link: msg.link } : {}) },
            });
        } catch (error) {
            return refuse(500, error instanceof Error ? error.message : String(error));
        }
        const to = agentAddress(record, slugs);
        if (msg.dedupeKey !== undefined) this.#dedupe.set(`${from}|${msg.dedupeKey}`, { messageId: message.id, to, at: now });
        await this.#deps.keys.used(source).catch(() => undefined);
        this.#deps.log?.(`[app-inbox] ${label} → ${to}: ${message.id}`);
        return { status: 201, body: { ok: true, messageId: message.id, to, delivery: appDelivery(record.mode, true) } };
    }
}

export interface AppInboxServer {
    readonly url: string;
    readonly port: number;
    readonly address: string;
    close(): Promise<void>;
}

/**
 * Listen on 127.0.0.1 — a literal address, never `localhost` (which may resolve to every interface's IPv6 twin) and never
 * 0.0.0.0. `port` is tried first (a remembered one); taken, the OS picks one. A body past the cap is cut off here,
 * before it is buffered whole.
 */
export async function startAppInboxServer(input: { readonly service: Pick<AppInboxService, 'handle'>; readonly port?: number }): Promise<AppInboxServer> {
    let bound = 0;
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const send = (r: AppInboxResponse): void => {
            if (res.headersSent) return;
            res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(r.headers ?? {}) });
            res.end(JSON.stringify(r.body));
        };
        const chunks: Buffer[] = [];
        let size = 0;
        let over = false;
        req.on('data', (chunk: Buffer) => {
            if (over) return;
            size += chunk.length;
            if (size > APP_LIMITS.requestBytes) {
                over = true;
                res.setHeader('connection', 'close');
                send(refuse(413, `a request is at most ${APP_LIMITS.requestBytes} bytes`));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (over) return;
            const headers: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
            input.service.handle({ method: req.method ?? 'GET', path: req.url ?? '/', port: bound, headers, body: Buffer.concat(chunks).toString('utf8') })
                .then(send, (error: unknown) => send(refuse(500, error instanceof Error ? error.message : String(error))));
        });
        req.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
    });
    try {
        await listen(input.port ?? 0);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !input.port) throw error;
        await listen(0);
    }
    const address = server.address() as AddressInfo;
    bound = address.port;
    return {
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        address: address.address,
        close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
    };
}
