import { Agent, request } from 'node:https';
import tls from 'node:tls';
import type { IncomingMessage } from 'node:http';
import { routeLabel, type ProxyRoute } from '../core/proxy-answer.js';
import type { SessionFetch } from './tynn-account.js';

/**
 * THE HOST'S HTTPS (P3.4 cut c; plan §13). A window's session fetch is Chromium's network stack. genie-host has Node, whose fetch
 * trusts only its bundled roots and has no OS proxy settings, which can break sign-in outright. This trusts:
 *   - Node's bundled roots: the public chain, real tynn.ai;
 *   - the OS store, as Node reads it: a test VM's alias CA, a company's root, and Genie's CA once the person has pressed Trust.
 *
 * NOT Genie's CA from its file. A CA that counts without the person's word, on calls that carry the Tynn token, would be wider
 * than the window, which trusted it only once it was in the OS store. A guard holds this (test/host-https-fetch.test.ts).
 *
 * VERIFICATION IS NEVER OFF. `rejectUnauthorized: true` is explicit on purpose: left unset, an inherited
 * NODE_TLS_REJECT_UNAUTHORIZED=0 would turn it off for the host, and Chromium never read that variable. A source guard holds this
 * (test/host-https-fetch.test.ts).
 *
 * ONLY https, and a redirect is refused: this carries bearer tokens, as the window's `redirect: 'error'` asked. GitHub's port asks to follow one on the same
 * origin (`followSameOrigin`), because a renamed repository is ordinary there: same scheme, host and port, a small limit, and the token stays with that origin
 * because nothing else is ever called. Anything else is refused, and says so.
 *
 * PROXIES: an explicit HTTPS_PROXY or NO_PROXY wins, then what the OS last said (`proxyRoutes`, proxy-memory.ts), then direct. A route
 * that fails to connect goes to the next one in the answer, and that is logged; with none left the error names the proxy, and nothing
 * goes around it. A certificate that fails is never a reason to try another route. What is still not covered: plan §13, "the host's
 * network".
 */
export interface HostHttpsOptions {
    /** The roots to trust. Default: Node's bundled ones and the OS store. Tests name theirs, so no test touches a real store. */
    readonly machineRoots?: () => readonly string[];
    /** Where proxies are read from. Default: the host's own environment. */
    readonly env?: NodeJS.ProcessEnv;
    /** What the OS said for this URL, as a window last heard it. */
    readonly proxyRoutes?: (url: string) => readonly ProxyRoute[];
    readonly log?: (line: string) => void;
    /** Follow this many redirects on the same origin. Absent: every redirect is refused. */
    readonly followSameOrigin?: number;
    /** Optional protocol-specific cap, enforced while receiving bytes, including chunked responses. */
    readonly maxResponseBytes?: number;
    /** A byte-preserving, backpressured body for signed Marketplace archives. */
    readonly streamResponse?: boolean;
}

export interface HostHttpsResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly headers: { get(name: string): string | null };
    readonly body?: ReadableStream<Uint8Array>;
    text(): Promise<string>;
}
export type HostHttpsFetch = (url: string, init: Parameters<SessionFetch>[1]) => Promise<HostHttpsResponse>;

function binaryBody(res: IncomingMessage, limit: number | undefined): ReadableStream<Uint8Array> {
    // No flowing data listener: the socket stays backpressured until its owner reads or cancels it.
    const iterator = res[Symbol.asyncIterator]();
    let bytes = 0;
    return new ReadableStream<Uint8Array>({
        start(controller) { res.on('error', error => controller.error(error)); },
        async pull(controller) {
            try {
                const part = await iterator.next();
                if (part.done) { controller.close(); return; }
                const chunk = part.value as Buffer;
                bytes += chunk.byteLength;
                if (limit !== undefined && bytes > limit) throw new Error('The response exceeds its size limit.');
                controller.enqueue(chunk);
            } catch (error) { controller.error(error); res.destroy(); }
        },
        cancel() { res.destroy(); },
    }, { highWaterMark: 0 });
}

/** Each of these is cached by Node for the process; so is this. A root added to the OS store is read at the next host start. */
let machineRoots: readonly string[] | null = null;
export function rootsOfThisMachine(): readonly string[] {
    if (machineRoots) return machineRoots;
    const read = (kind: 'bundled' | 'system'): readonly string[] => { try { return tls.getCACertificates(kind); } catch { return []; } };
    const bundled = read('bundled');
    machineRoots = [...(bundled.length > 0 ? bundled : tls.rootCertificates), ...read('system')];
    return machineRoots;
}

/** A route that could not carry the call, named: the account says "unreachable through <proxy>", and never "signed out". */
export class ProxyRouteError extends Error {
    constructor(message: string, readonly proxy: string) { super(message); this.name = 'ProxyRouteError'; }
}

/** Connection-level: the proxy could not carry it. A certificate failure is not on this list, on purpose. */
const ROUTE_FAILURES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);
const codeOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? '');
const isRouteFailure = (error: unknown): boolean => ROUTE_FAILURES.has(codeOf(error)) || codeOf(error).startsWith('ERR_PROXY');
const explicitOf = (env: NodeJS.ProcessEnv, name: string): string | undefined => env[name] || env[name.toLowerCase()] || undefined;

type Route = ProxyRoute | { readonly kind: 'env'; readonly label: string };
const labelOf = (route: Route): string => (route.kind === 'env' ? route.label : routeLabel(route));
function hostOfProxy(url: string): string {
    try { return new URL(url).host; } catch { return 'the proxy in HTTPS_PROXY'; }
}

export function hostHttpsFetch(options: HostHttpsOptions = {}): HostHttpsFetch {
    const env = options.env ?? process.env;
    /** One agent per route: a context over every root costs real time, and a call should not. */
    const agents = new Map<string, Agent>();
    const agentFor = (route: Route): Agent => {
        const key = route.kind === 'env' ? 'env' : route.kind === 'direct' ? 'direct' : `${route.kind}:${labelOf(route)}`;
        const held = agents.get(key);
        if (held) return held;
        const noProxy = explicitOf(env, 'NO_PROXY');
        const proxyEnv: NodeJS.ProcessEnv = route.kind === 'env' ? { ...env }
            : route.kind === 'proxy' ? { HTTPS_PROXY: `${route.scheme}://${route.host}:${route.port}`, ...(noProxy ? { NO_PROXY: noProxy } : {}) }
                : {};
        const agent = new Agent({ ca: [...(options.machineRoots ?? rootsOfThisMachine)()], rejectUnauthorized: true, proxyEnv } as ConstructorParameters<typeof Agent>[0]);
        agents.set(key, agent);
        return agent;
    };
    const routesFor = (url: string): readonly Route[] => {
        const explicit = explicitOf(env, 'HTTPS_PROXY');
        if (explicit) return [{ kind: 'env', label: hostOfProxy(explicit) }];
        return options.proxyRoutes?.(url) ?? [{ kind: 'direct' }];
    };

    /** Where a redirect points, when it may be followed, by the fetch standard's rules for the method. */
    const REDIRECT_LIMIT = options.followSameOrigin ?? 0;
    const redirected = (target: URL, init: Parameters<SessionFetch>[1], status: number, location: string | undefined, hops: number): { target: URL; init: Parameters<SessionFetch>[1] } => {
        if (REDIRECT_LIMIT === 0 || !location) throw new Error(`${target.host} answered with a redirect (${status}), which is refused.`);
        if (hops >= REDIRECT_LIMIT) throw new Error(`${target.host} sent too many redirects (${REDIRECT_LIMIT}).`);
        const next = new URL(location, target);
        if (next.origin !== target.origin) throw new Error(`${target.host} answered with a redirect (${status}) to another origin, ${next.origin}, which is refused: a token is never carried there.`);
        if ((status === 301 || status === 302) && init.method !== 'GET' || status === 303) {
            const { body: _body, ...rest } = init;
            const headers = Object.fromEntries(Object.entries(init.headers).filter(([name]) => name.toLowerCase() !== 'content-type'));
            return { target: next, init: { ...rest, method: 'GET', headers } };
        }
        return { target: next, init };
    };

    const send = (target: URL, init: Parameters<SessionFetch>[1], agent: Agent, hops = 0): ReturnType<HostHttpsFetch> => new Promise((resolve, reject) => {
        const ask = request(target, { method: init.method, headers: init.headers, agent, rejectUnauthorized: true, signal: init.signal }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
                res.destroy();
                try {
                    const next = redirected(target, init, status, res.headers.location, hops);
                    resolve(send(next.target, next.init, agent, hops + 1));
                } catch (error) { reject(error as Error); }
                return;
            }
            const headers = { get: (name: string): string | null => { const value = res.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value ?? null; } };
            if (options.streamResponse) {
                const body = binaryBody(res, options.maxResponseBytes);
                resolve({ ok: status >= 200 && status < 300, status, headers, body, text: async () => {
                    const reader = body.getReader(); const chunks: Uint8Array[] = [];
                    try {
                        for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); }
                        return Buffer.concat(chunks).toString('utf8');
                    } finally { reader.releaseLock(); }
                } });
                return;
            }
            const chunks: Buffer[] = [];
            const body = new Promise<string>((done, failed) => {
                let bytes = 0;
                res.on('data', (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (options.maxResponseBytes !== undefined && bytes > options.maxResponseBytes) {
                        const error = new Error('The response exceeds its size limit.');
                        failed(error);
                        res.destroy(error);
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
                res.on('error', failed);
                res.on('close', () => { if (!res.complete) failed(new Error('The connection closed before the answer finished.')); });
            });
            // A status-only caller need not read it; its failure must still be handled.
            void body.catch(() => {});
            resolve({ ok: status >= 200 && status < 300, status, headers, text: () => body });
        });
        ask.on('error', reject);
        ask.end(init.body);
    });

    return async (url, init) => {
        const target = new URL(url);
        if (target.protocol !== 'https:') throw new Error(`The host calls https only: ${target.protocol}`);
        if (init.signal.aborted) throw Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });
        const routes = routesFor(url);
        for (const [index, route] of routes.entries()) {
            const next = routes[index + 1];
            let failure: ProxyRouteError;
            if (route.kind === 'unsupported') {
                failure = new ProxyRouteError(route.port === 0
                    ? `The OS's proxy answer could not be read (${route.host}), so ${target.host} was not called.`
                    : `The OS names a ${route.scheme.toUpperCase()} proxy (${labelOf(route)}), which the host cannot use, so ${target.host} could not be reached.`, labelOf(route));
            } else {
                try {
                    return await send(target, init, agentFor(route));
                } catch (error) {
                    if (route.kind === 'direct' || !isRouteFailure(error) || init.signal.aborted) throw error;
                    const message = error instanceof Error ? error.message : String(error);
                    failure = new ProxyRouteError(/\b407\b/.test(message)
                        ? `${target.host} could not be reached: the proxy ${labelOf(route)} asks for a sign-in (407), and the host has no prompt to answer it with.`
                        : `${target.host} could not be reached through the proxy ${labelOf(route)} (${codeOf(error)}).`, labelOf(route));
                }
            }
            if (!next) throw failure;
            options.log?.(`${failure.message} Trying ${labelOf(next)}, as the OS's answer allows.`);
        }
        throw new Error('The OS gave no route.');
    };
}
