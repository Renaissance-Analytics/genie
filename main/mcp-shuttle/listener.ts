import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import { closeAllStreams, openGetStream } from '../mcp/server-push';
import { resolveTerminal, AMBIGUOUS_TERMINAL_MESSAGE, type EndpointRoute } from '../mcp/terminal-resolution';
import { SHUTTLE_ERROR_CODES, type ShuttleCore, type ShuttleRequest, type ShuttleResponse } from './core';
import type { ManifestList, ManifestStore } from './manifest-store';

/**
 * THE SHUTTLE'S LISTENER — the socket every agent's `.mcp.json` already points at.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.2, §4.2, §4.3.
 *
 * The URL is byte-identical to the in-process server's (`/mcp/<token>`), so no
 * `.mcp.json` is rewritten and no agent reconfigures anything. What changes is who
 * answers:
 *
 * - **Discovery is answered here, from the published manifest.** `initialize`,
 *   `tools/list`, `prompts/list`, `resources/list` and `ping` never reach Genie. While
 *   Genie is being replaced there is nobody to ask, and an agent that starts during
 *   the swap must still be able to connect.
 * - **Everything else is forwarded through the core**, which parks it while Genie is
 *   away and never replays a call that was already running (see `core.ts`). That
 *   includes methods this listener has never heard of, so a newer Genie can answer a
 *   new method without a new shuttle — which is what keeps most upgrades shallow.
 * - **Which terminal a call acts for** is resolved by the same function `server.ts`
 *   uses, so the two cannot disagree. A `tools/call` that resolves none is refused
 *   here, with no Genie round-trip, exactly as today.
 *
 * ## A call that has to wait keeps its connection alive
 *
 * A parked call can wait the whole grace window — far past a client's idle timeout —
 * and some calls (ForceTheQuestion) legitimately block on a human. So a call that has
 * not settled within `streamAfterMs` is switched to an event stream that heartbeats,
 * and its answer arrives as the last event on the same HTTP response. A call that
 * settles quickly is a single JSON response, as it is today.
 *
 * The in-process server decides this by reading each tool's `action` argument. The
 * shuttle does not, and must not (§4.3: it "never inspects, rewrites or interprets
 * tool arguments") — and it could not know anyway, because whether a call is parked
 * has nothing to do with its arguments.
 *
 * ## A throw here is every agent's tools, at once
 *
 * The shuttle is one process serving every agent on the machine (§9.1), so no request
 * may unwind out of `handle`. Anything unexpected is a 500 for that one request.
 */

export interface ShuttleRoutes {
    /** What a URL token addresses — inherited from Genie's persisted maps, never
     *  minted here (§9.2), or null for a token nobody issued. */
    endpoint(token: string): EndpointRoute | null;
    /** A workspace's terminals, as Genie last published them. */
    workspaceTerminals(workspaceId: string): string[];
}

export interface ShuttleListenerOptions {
    core: ShuttleCore;
    manifest: ManifestStore;
    routes: ShuttleRoutes;
    /** How long a call may take before its response becomes a heartbeat stream. */
    streamAfterMs?: number;
    /** Heartbeat interval for streamed responses and the GET stream. ~25s sits
     *  under the common 30–60s client idle windows. */
    heartbeatMs?: number;
}

export interface ShuttleListener {
    /** An `http.createServer` request listener. Never throws. */
    handle(req: http.IncomingMessage, res: http.ServerResponse): void;
    /** End every open server→client stream. */
    close(): void;
}

export const STREAM_AFTER_MS = 1_000;
export const HEARTBEAT_MS = 25_000;
const MAX_BODY_BYTES = 1_000_000;

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method: string; params?: unknown };

class BodyTooLarge extends Error {}

const HEADERS = {
    // Loopback only; no cross-origin use, but explicit — as server.ts is.
    'Access-Control-Allow-Origin': '127.0.0.1',
};

function send(res: http.ServerResponse, status: number, body?: unknown, extra?: Record<string, string>): void {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json', ...HEADERS, ...(extra ?? {}) });
    res.end(body === undefined ? undefined : JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                reject(new BodyTooLarge());
                req.removeAllListeners('data');
                req.resume(); // drain, so the 413 can still be written
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

const isMessage = (v: unknown): v is JsonRpcMessage =>
    !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { method?: unknown }).method === 'string';

const reply = (id: JsonRpcMessage['id'], response: ShuttleResponse) => ({ jsonrpc: '2.0', id: id ?? null, ...response });

/** Discovery with nothing published: said by name, never as an empty list. */
const nothingPublished = (): ShuttleResponse => ({
    error: {
        code: SHUTTLE_ERROR_CODES.GenieDetached,
        message:
            'Genie has not published its tools to the MCP shuttle yet (it may still be starting). ' +
            'Your connection is fine. Retry in a few seconds.',
    },
});

export function createShuttleListener(opts: ShuttleListenerOptions): ShuttleListener {
    const { core, manifest, routes } = opts;
    const streamAfterMs = opts.streamAfterMs ?? STREAM_AFTER_MS;
    const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;

    const list = (name: ManifestList): ShuttleResponse => {
        const items = manifest[name]();
        return items === null ? nothingPublished() : { result: { [name]: items } };
    };

    /** Answer from the manifest, or undefined when only Genie can answer. */
    const answerLocally = (msg: JsonRpcMessage): ShuttleResponse | undefined => {
        switch (msg.method) {
            case 'ping':
                // The connection is alive whether or not Genie is.
                return { result: {} };
            case 'initialize': {
                const server = manifest.server();
                if (!server) return nothingPublished();
                const requested = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
                const protocolVersion =
                    typeof requested === 'string' && server.protocolVersions.includes(requested)
                        ? requested
                        : server.protocolVersions[0];
                return {
                    result: {
                        protocolVersion,
                        capabilities: server.capabilities,
                        serverInfo: server.serverInfo,
                        instructions: server.instructions,
                    },
                };
            }
            case 'tools/list':
                return list('tools');
            case 'prompts/list':
                return list('prompts');
            case 'resources/list': {
                const server = manifest.server();
                if (!server) return nothingPublished();
                // Today Genie declares no resources and answers this -32601. Serving
                // an empty list instead would change what every client sees.
                if (!server.capabilities.resources) {
                    return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
                }
                return list('resources');
            }
            default:
                return undefined;
        }
    };

    /**
     * Hand a request to Genie through the core, answering as JSON if it settles
     * quickly and over a heartbeat stream if it does not.
     */
    const forward = (
        res: http.ServerResponse,
        msg: JsonRpcMessage,
        route: { token: string; terminalId: string },
    ): void => {
        let settled = false;
        let streaming = false;
        let stopBeating = (): void => {};

        const write = (chunk: string): void => {
            if (res.writableEnded || res.destroyed) return;
            try {
                res.write(chunk);
            } catch {
                /* the client went away; the call still runs to completion in Genie */
            }
        };
        const event = (body: unknown): void => write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);

        const startStreaming = (): void => {
            if (settled || res.destroyed) return;
            streaming = true;
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                ...HEADERS,
            });
            write(': open\n\n');

            const progressToken = (msg.params as { _meta?: { progressToken?: unknown } } | undefined)?._meta
                ?.progressToken;
            let progress = 0;
            const beat = setInterval(() => {
                write(': heartbeat\n\n');
                if (typeof progressToken !== 'string' && typeof progressToken !== 'number') return;
                progress += 1;
                event({
                    jsonrpc: '2.0',
                    method: 'notifications/progress',
                    params: {
                        progressToken,
                        progress,
                        message:
                            core.state() === 'attached'
                                ? 'Genie is still working on this call…'
                                : 'Genie is being restarted; this call runs as soon as it is back…',
                    },
                });
            }, heartbeatMs);
            beat.unref?.();
            stopBeating = () => clearInterval(beat);
        };

        const timer = setTimeout(startStreaming, streamAfterMs);
        timer.unref?.();
        const hangUp = (): void => {
            clearTimeout(timer);
            stopBeating();
        };
        res.on('close', hangUp);

        // Time-based transitions are advanced on the event that needs them: a call
        // arriving after the grace window must fail now, not wait to be parked.
        core.tick();
        core.call(
            msg as ShuttleRequest,
            (response) => {
                if (settled) return;
                settled = true;
                hangUp();
                const body = reply(msg.id, response);
                if (!streaming) {
                    send(res, 200, body);
                    return;
                }
                event(body);
                if (!res.writableEnded) res.end();
            },
            route,
        );
    };

    const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const m = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]+)$/);
        if (!m) {
            send(res, 404, { error: 'not found' });
            return;
        }
        const token = m[1]!;
        const endpoint = routes.endpoint(token);
        if (!endpoint) {
            send(res, 404, { error: 'unknown endpoint' });
            return;
        }

        if (req.method === 'GET') {
            // Held by the shuttle, so it does not drop when Genie is replaced.
            openGetStream(req, res, token, { heartbeatMs });
            return;
        }
        if (req.method !== 'POST') {
            send(res, 405, { error: 'method not allowed' });
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(await readBody(req));
        } catch (e) {
            if (e instanceof BodyTooLarge) {
                send(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
                return;
            }
            send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
        }
        if (!isMessage(parsed)) {
            send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
            return;
        }
        const msg = parsed;

        // A notification carries no id and wants no body.
        if (msg.id === undefined || msg.id === null || msg.method.startsWith('notifications/')) {
            send(res, 202);
            return;
        }

        const local = answerLocally(msg);
        if (local) {
            // Echoable session id, as server.ts hands out — assigned, never required.
            const extra = msg.method === 'initialize' && local.result ? { 'Mcp-Session-Id': randomUUID() } : undefined;
            send(res, 200, reply(msg.id, local), extra);
            return;
        }

        const argTerminalId = (msg.params as { arguments?: { terminalId?: unknown } } | undefined)?.arguments
            ?.terminalId;
        const terminalId = resolveTerminal(
            endpoint,
            (id) => routes.workspaceTerminals(id),
            typeof argTerminalId === 'string' ? argTerminalId : undefined,
        );
        if (terminalId === null && msg.method === 'tools/call') {
            send(res, 200, reply(msg.id, { error: { code: -32602, message: AMBIGUOUS_TERMINAL_MESSAGE } }));
            return;
        }

        forward(res, msg, { token, terminalId: terminalId ?? '' });
    };

    return {
        handle(req, res) {
            handle(req, res).catch(() => {
                try {
                    send(res, 500, { error: 'internal error' });
                } catch {
                    /* response already gone */
                }
            });
        },
        close() {
            closeAllStreams();
        },
    };
}
