import http from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket } from 'ws';

import type { Channel, Frame } from '../../remote/relay-protocol';
import { loopbackTarget } from './proxy-paths';

/**
 * Bridge an admitted relay member's frames onto THIS machine's member-facing
 * server on 127.0.0.1 (genie#680) — the desktop counterpart of genie-cloud's
 * `src/relay/loopback-proxy.ts`, and the reason no host-side refactor was needed
 * (spec §1.5): REST becomes a loopback request; `events` and `term` bridge the
 * real local WebSockets; `site` drives the real `/api/site/*` reverse proxy.
 *
 * DIFFERENCE FROM genie-cloud: each member session authenticates with its OWN
 * local session (`tokenFor(sid)`), minted from its grant, so the local server
 * judges every request by what that member may reach — never one shared owner
 * token. And every path a member writes is checked against {@link loopbackTarget}
 * before it is dialled.
 */

/** Answered by the proxy itself, not proxied (see genie-cloud RELAY_FEATURES_PATH). */
export const RELAY_FEATURES_PATH = '/api/relay/features';
export const RELAY_FEATURES = { termMultiplex: true } as const;

export type FrameHandler = (frame: Frame, reply: (f: Frame) => void) => void;

export interface LoopbackProxy {
    handle: FrameHandler;
    /** Close every stream a member session opened (it ended). */
    closeSession(sid: string): void;
}

export function createLoopbackProxy(opts: {
    /** `http://127.0.0.1:<port>`, or null while the local server is not listening. */
    baseUrl: () => string | null;
    /** The local session token for a member session, or null when it has none. */
    tokenFor: (sid: string) => string | null;
    fetchImpl?: typeof fetch;
}): LoopbackProxy {
    const doFetch = opts.fetchImpl ?? fetch;
    const streams = new Map<string, WebSocket>();
    const pendingUp = new Map<string, string[]>();
    const siteHttp = new Map<string, http.ClientRequest>();
    const siteWs = new Map<string, Duplex>();
    const MAX_PENDING_UP = 64;
    const key = (sid: string, channel: Channel, reqId?: string) => (reqId ? `${sid}:${channel}:${reqId}` : `${sid}:${channel}`);

    const refuseRest = (frame: Frame, reply: (f: Frame) => void, status: number, error: string) =>
        reply({ kind: 'data', channel: 'rest', sid: frame.sid, reqId: frame.reqId, payload: { status, body: JSON.stringify({ error }) } });

    const handleRest: FrameHandler = (frame, reply) => {
        const p = (frame.payload ?? {}) as { path?: string; method?: string; headers?: Record<string, string>; body?: string };
        if (p.path === RELAY_FEATURES_PATH) {
            reply({ kind: 'data', channel: 'rest', sid: frame.sid, reqId: frame.reqId, payload: { status: 200, body: JSON.stringify({ features: RELAY_FEATURES }) } });
            return;
        }
        const base = opts.baseUrl();
        const token = opts.tokenFor(frame.sid);
        const target = loopbackTarget('rest', p.path ?? '');
        if (!target) return refuseRest(frame, reply, 403, 'not reachable over the relay');
        if (!base || !token) return refuseRest(frame, reply, 503, 'this workstation is not serving remote sessions');
        void (async () => {
            try {
                // Member-supplied headers never carry authority: the session's own token wins.
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(p.headers ?? {})) {
                    if (k.toLowerCase() !== 'authorization' && k.toLowerCase() !== 'cookie') headers[k] = v;
                }
                const res = await doFetch(base + target, {
                    method: p.method ?? 'GET',
                    headers: { ...headers, Authorization: `Bearer ${token}` },
                    body: p.body,
                });
                reply({ kind: 'data', channel: 'rest', sid: frame.sid, reqId: frame.reqId, payload: { status: res.status, body: await res.text() } });
            } catch (err) {
                reply({ kind: 'error', channel: 'rest', sid: frame.sid, reqId: frame.reqId, code: 'proxy', reason: err instanceof Error ? err.message : 'loopback error' });
            }
        })();
    };

    const openStream: FrameHandler = (frame, reply) => {
        const channel = frame.channel;
        const k = key(frame.sid, channel, frame.reqId);
        if (streams.has(k)) return;
        const back = (f: Omit<Frame, 'sid' | 'channel'>) =>
            reply({ ...f, channel, sid: frame.sid, ...(frame.reqId ? { reqId: frame.reqId } : {}) } as Frame);
        const requested = (frame.payload as { path?: string } | undefined)?.path ?? `/ws/${channel}`;
        const target = loopbackTarget(channel, requested);
        const base = opts.baseUrl();
        const token = opts.tokenFor(frame.sid);
        if (!target || !base || !token) {
            back({ kind: 'close' });
            return;
        }
        const url = new URL(base.replace(/^http/, 'ws') + target);
        url.searchParams.set('token', token);
        const local = new WebSocket(url.toString());
        streams.set(k, local);
        local.on('message', (data: Buffer) => back({ kind: 'data', payload: data.toString('utf8') }));
        local.on('open', () => {
            const queued = pendingUp.get(k) ?? [];
            pendingUp.delete(k);
            for (const msg of queued) {
                try {
                    local.send(msg);
                } catch {
                    /* closing */
                }
            }
        });
        local.on('close', () => {
            streams.delete(k);
            pendingUp.delete(k);
            back({ kind: 'close' });
        });
        local.on('error', () => {
            /* surfaced via close */
        });
    };

    const handleSite: FrameHandler = (frame, reply) => {
        const reqId = frame.reqId;
        if (!reqId) return;
        const k = `${frame.sid}:${reqId}`;
        const data = (payload: unknown) => reply({ kind: 'data', channel: 'site', sid: frame.sid, reqId, payload });
        const done = () => {
            siteHttp.delete(k);
            siteWs.delete(k);
            reply({ kind: 'close', channel: 'site', sid: frame.sid, reqId });
        };
        const fail = (reason: string) => {
            siteHttp.delete(k);
            siteWs.delete(k);
            reply({ kind: 'error', channel: 'site', sid: frame.sid, reqId, code: 'proxy', reason });
        };

        if (frame.kind === 'open') {
            const open = (frame.payload ?? {}) as { method?: string; path?: string; headers?: Record<string, string>; upgrade?: boolean };
            const target = loopbackTarget('site', open.path ?? '');
            const base = opts.baseUrl();
            const token = opts.tokenFor(frame.sid);
            if (!target || !base || !token) return fail('not reachable over the relay');
            const baseUrl = new URL(base);
            const headers: http.OutgoingHttpHeaders = {};
            for (const [name, value] of Object.entries(open.headers ?? {})) {
                // The relay session IS the rebinding protection; a member's own
                // Origin/credentials never ride through.
                const lower = name.toLowerCase();
                if (lower === 'origin' || lower === 'authorization' || lower === 'cookie') continue;
                headers[name] = value;
            }
            let dialPath = target;
            if (open.upgrade) dialPath += `${dialPath.includes('?') ? '&' : '?'}__genie_token=${encodeURIComponent(token)}`;
            else headers.authorization = `Bearer ${token}`;
            const upReq = http.request(
                { host: baseUrl.hostname, port: Number(baseUrl.port), method: open.method || 'GET', path: dialPath, headers },
                (upRes) => {
                    data({ t: 'response', status: upRes.statusCode ?? 502, headers: upRes.headers });
                    upRes.on('data', (c: Buffer) => data({ t: 'body', data: c.toString('base64') }));
                    upRes.on('end', done);
                },
            );
            upReq.on('upgrade', (upRes, upSocket, upHead) => {
                siteWs.set(k, upSocket);
                data({ t: 'upgraded', status: upRes.statusCode ?? 101, statusText: upRes.statusMessage ?? '', headers: upRes.headers });
                if (upHead?.length) data({ t: 'body', data: upHead.toString('base64') });
                upSocket.on('data', (c: Buffer) => data({ t: 'body', data: c.toString('base64') }));
                upSocket.on('close', done);
                upSocket.on('error', () => fail('upstream socket error'));
            });
            upReq.on('error', () => fail('loopback dial failed'));
            siteHttp.set(k, upReq);
            if (open.upgrade) upReq.end();
            return;
        }
        if (frame.kind === 'data') {
            const up = (frame.payload ?? {}) as { t?: string; data?: string };
            if (up.t === 'body' && typeof up.data === 'string') {
                const chunk = Buffer.from(up.data, 'base64');
                const ws = siteWs.get(k);
                if (ws) ws.write(chunk);
                else siteHttp.get(k)?.write(chunk);
            } else if (up.t === 'end') {
                siteHttp.get(k)?.end();
            }
            return;
        }
        if (frame.kind === 'close') {
            siteHttp.get(k)?.destroy();
            siteWs.get(k)?.destroy();
            siteHttp.delete(k);
            siteWs.delete(k);
        }
    };

    const handle: FrameHandler = (frame, reply) => {
        if (frame.channel === 'site') return handleSite(frame, reply);
        if (frame.channel === 'rest' && (frame.kind === 'open' || frame.kind === 'data')) return handleRest(frame, reply);
        if (frame.channel === 'term' || frame.channel === 'events') {
            const k = key(frame.sid, frame.channel, frame.reqId);
            if (frame.kind === 'open') return openStream(frame, reply);
            if (frame.kind === 'data') {
                const msg = toLocalUpMessage(frame.channel, frame.payload);
                const local = streams.get(k);
                if (local?.readyState === WebSocket.OPEN) local.send(msg);
                else if (local?.readyState === WebSocket.CONNECTING) {
                    const q = pendingUp.get(k) ?? [];
                    if (q.length >= MAX_PENDING_UP) q.shift();
                    q.push(msg);
                    pendingUp.set(k, q);
                }
                return;
            }
            if (frame.kind === 'close') {
                streams.get(k)?.close();
                streams.delete(k);
                pendingUp.delete(k);
            }
        }
    };

    return {
        handle,
        closeSession(sid: string) {
            for (const [k, ws] of streams) {
                if (k.startsWith(`${sid}:`)) {
                    ws.close();
                    streams.delete(k);
                    pendingUp.delete(k);
                }
            }
            for (const [k, req] of siteHttp) {
                if (k.startsWith(`${sid}:`)) {
                    req.destroy();
                    siteHttp.delete(k);
                }
            }
            for (const [k, sock] of siteWs) {
                if (k.startsWith(`${sid}:`)) {
                    sock.destroy();
                    siteWs.delete(k);
                }
            }
        },
    };
}

/**
 * A member's term input, as the local `/ws/term` expects it. A Genie remote window
 * already sends `{"type":"input"|"resize",…}` — forwarded verbatim; a bare string
 * or `{workspaceId,data}` is wrapped as input. Mirrors genie-cloud `toLocalUpMessage`.
 */
export function toLocalUpMessage(channel: Channel, payload: unknown): string {
    if (channel === 'term' && typeof payload === 'string') {
        try {
            const parsed = JSON.parse(payload) as { type?: unknown };
            if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') return payload;
        } catch {
            /* a raw input string */
        }
    }
    const raw = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : payload;
    const data = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    return channel === 'term' ? JSON.stringify({ type: 'input', data }) : data;
}
