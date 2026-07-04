import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Readable, type Duplex } from 'node:stream';
import { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import {
    connectWorkstation,
    connectRemote,
    disconnectConnKey,
    getSiteCarrier,
} from '../index';
import { createSiteShim, type GenTarget, type SiteShim } from '../site-proxy';
import { SessionCa } from '../site-ca';
import { startMobileServer, stopMobileServer, mobileServerState, setLocked } from '../../mobile/server';
import { _resetAuthForTest, currentPin } from '../../mobile/auth';
import { _resetAuditForTest, recentAudit } from '../../mobile/audit';
import { _resetSiteProxyForTest, type ResolvedSite, type SiteProxyDeps } from '../../mobile/site-proxy';
import type { MobileDataDeps } from '../../mobile/api';

/**
 * Serve-local-sites Phase E — the RELAY carrier, end-to-end (design §2.0/§8-E).
 *
 * Extends the in-process fake-relay harness (relay-transport.test.ts) with a
 * `site` channel: the fake relay member server stands in for genie-cloud's
 * host-side relay dispatch — it receives the member's `site` frames and hands
 * each to the REAL host mobile server's `handleSiteProxy` (the SAME handler as
 * the tailnet path), self-pairing the Bearer IN MAIN, then streams the response
 * back as `site` frames. So we prove the held-until: a member with NO shared
 * tailnet issues a `https://tynn.gen` request that round-trips over the (fake)
 * relay into `handleSiteProxy` and back, with the token stays-in-main + kill-
 * switch + allowlist all honoured over the relay carrier — identical to tailnet.
 *
 * Native-ABI note: no `new Database()` here (this uses injected SiteProxyDeps,
 * like the Phase-C site-proxy test), so it runs under plain Node.
 */

// --- test-controlled host allowlist (injected, no sqlite) ------------------
let masterEnabled = true;
const enabledSites = new Map<string, ResolvedSite>();
const siteProxy: SiteProxyDeps = {
    localSitesEnabled: () => masterEnabled,
    resolveSite: (siteId) => enabledSites.get(siteId) ?? null,
};

// --- fake loopback upstreams (an http echo + a ws echo) --------------------
let httpUpstream: http.Server;
let wsHttp: http.Server;
let wsUpstream: WebSocketServer;
let lastHttpAuth: string | undefined; // must stay undefined (Genie token stripped)

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
}

async function startUpstreams(): Promise<void> {
    httpUpstream = http.createServer((req, res) => {
        lastHttpAuth = req.headers.authorization;
        const body = `host=${req.headers.host}`; // echoes the (rewritten) Host — the crux
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    });
    wsHttp = http.createServer();
    wsUpstream = new WebSocketServer({ server: wsHttp });
    wsUpstream.on('connection', (sock, req) => {
        sock.send(String(req.headers.host)); // first frame = the Host the proxy rewrote
        sock.on('message', (m) => sock.send(m.toString()));
    });
    const httpPort = await listen(httpUpstream);
    const wsPort = await listen(wsHttp);
    enabledSites.set('sitehttp', { hostname: 'tynn.test', scheme: 'http', port: httpPort });
    enabledSites.set('sitews', { hostname: 'tynn.test', scheme: 'http', port: wsPort });
    // 'ghost' is deliberately NOT registered — an enabled `.gen` whose host-side
    // siteId doesn't resolve, to prove the HOST allowlist bites over the relay.
}

function stopUpstreams(): void {
    wsUpstream?.close();
    for (const s of [httpUpstream, wsHttp]) {
        try {
            s?.close();
        } catch {
            /* already closed */
        }
    }
}

// --- the real mobile server (host side) ------------------------------------
let appDir: string;
let wsRoot: string;

const dataDeps = (): MobileDataDeps =>
    ({
        listWorkspaces: () => [{ id: 'ws-1', project_name: 'Demo', path: wsRoot }],
        listTerminalSpecs: () => [],
        listAllProcesses: () => [],
        liveTerminalIds: () => [],
        startProcess: () => {},
        stopProcess: () => {},
        restartProcess: () => {},
        createAgentTerminal: () => ({ id: 't', scrollback: '' }),
        killTerminalById: () => true,
        writeToTerminal: () => true,
        readTerminalOutput: () => ({ data: '', cursor: 0, dropped: false }),
        getScrollback: () => '',
        resize: () => true,
        listPendingQuestions: () => [],
        answerPendingQuestion: () => true,
        updateStatus: () => ({ state: 'up-to-date', currentVersion: '0.0.0-test', latestVersion: null, readyToInstall: false }),
        installUpdate: () => ({ ok: false, reason: 'not-ready' as const }),
        checkUpdate: async () => ({ state: 'up-to-date', currentVersion: '0.0.0-test', latestVersion: null, readyToInstall: false }),
    }) as unknown as MobileDataDeps;

async function startMobile(): Promise<number> {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-relaysite-app-'));
    fs.writeFileSync(path.join(appDir, 'mobile.html'), '<!doctype html><html><body>m</body></html>');
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-relaysite-ws-'));
    await startMobileServer({
        serverVersion: '0.0.0-test',
        userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'genie-relaysite-ud-')),
        appDir,
        enabled: true,
        configuredPort: () => 0,
        data: dataDeps(),
        siteProxy,
        confirmPair: async () => true,
        bindIpOverride: '127.0.0.1',
    });
    const st = mobileServerState();
    if (!st.running || !st.port) throw new Error('mobile server did not bind');
    return st.port;
}

function pair(port: number): Promise<string> {
    const body = JSON.stringify({ pin: currentPin() });
    return new Promise((resolve, reject) => {
        const r = http.request(
            {
                host: '127.0.0.1',
                port,
                path: '/api/pair',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            },
            (res) => {
                let b = '';
                res.on('data', (c) => (b += c));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(b).token as string);
                    } catch {
                        reject(new Error('pair failed'));
                    }
                });
            },
        );
        r.on('error', reject);
        r.write(body);
        r.end();
    });
}

// --- the fake relay member server (genie-cloud's host-side dispatch) --------
/**
 * Welcomes member-hello, auto-acks the events-bridge `/api/questions` sync, and
 * dispatches `site` frames: dial the REAL mobile server's `/api/site/…` (raw
 * `http.request` so a WS upgrade preserves the browser's `Sec-WebSocket-Key`),
 * inject the self-pair Bearer IN MAIN, and stream the reply back as `site`
 * frames. `openHeaders` records each open's headers so the test can prove the
 * member sent NO Authorization (the Bearer is host-side-injected only).
 */
function startSiteRelayStub(getMobile: () => { port: number; token: string }) {
    const wss = new WebSocketServer({ port: 0 });
    let socket: WsServerSocket | null = null;
    const sid = 'sid-site-1';
    const httpReqs = new Map<string, http.ClientRequest>();
    const wsSocks = new Map<string, Duplex>();
    const openHeaders: Record<string, Record<string, unknown>> = {};

    const send = (frame: object): void => {
        if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };
    const siteData = (reqId: string, payload: unknown): void =>
        send({ kind: 'data', channel: 'site', sid, reqId, payload });
    const siteClose = (reqId: string): void => send({ kind: 'close', channel: 'site', sid, reqId });

    function handleSite(frame: { kind: string; reqId?: string; payload?: any }): void {
        const reqId = frame.reqId!;
        const { port, token } = getMobile();
        if (frame.kind === 'open') {
            const payload = frame.payload ?? {};
            openHeaders[reqId] = { ...(payload.headers ?? {}) };
            const isWs = !!payload.upgrade;
            const headers: Record<string, unknown> = { ...(payload.headers ?? {}) };
            // Host-side dispatch presents to the LOCAL mobile server as a
            // non-browser client (no Origin ⇒ originAllowed) and self-pairs.
            delete headers.origin;
            delete headers.Origin;
            let dialPath = payload.path as string;
            if (isWs) {
                dialPath += `${dialPath.includes('?') ? '&' : '?'}__genie_token=${encodeURIComponent(token)}`;
            } else {
                headers['authorization'] = `Bearer ${token}`; // Bearer injected IN MAIN
            }
            const upReq = http.request(
                { host: '127.0.0.1', port, method: payload.method || 'GET', path: dialPath, headers: headers as http.OutgoingHttpHeaders },
                (upRes) => {
                    siteData(reqId, { t: 'response', status: upRes.statusCode, headers: upRes.headers });
                    upRes.on('data', (c: Buffer) => siteData(reqId, { t: 'body', data: Buffer.from(c).toString('base64') }));
                    upRes.on('end', () => siteClose(reqId));
                },
            );
            upReq.on('upgrade', (upRes, upSocket, upHead) => {
                wsSocks.set(reqId, upSocket);
                siteData(reqId, {
                    t: 'upgraded',
                    status: upRes.statusCode,
                    statusText: upRes.statusMessage,
                    headers: upRes.headers,
                });
                // Bytes buffered past the 101 (the ws echo's first frame lands here).
                if (upHead && upHead.length) siteData(reqId, { t: 'body', data: Buffer.from(upHead).toString('base64') });
                upSocket.on('data', (c: Buffer) => siteData(reqId, { t: 'body', data: Buffer.from(c).toString('base64') }));
                upSocket.on('close', () => siteClose(reqId));
                upSocket.on('error', () => send({ kind: 'error', channel: 'site', sid, reqId, code: 'up', reason: 'upstream error' }));
            });
            upReq.on('error', () => send({ kind: 'error', channel: 'site', sid, reqId, code: 'dial', reason: 'dial failed' }));
            httpReqs.set(reqId, upReq);
            if (isWs) upReq.end(); // a WS upgrade has no request body
        } else if (frame.kind === 'data') {
            const p = frame.payload;
            if (p?.t === 'body') {
                const chunk = Buffer.from(p.data, 'base64');
                const ws = wsSocks.get(reqId);
                if (ws) ws.write(chunk);
                else httpReqs.get(reqId)?.write(chunk);
            } else if (p?.t === 'end') {
                httpReqs.get(reqId)?.end();
            }
        } else if (frame.kind === 'close') {
            httpReqs.get(reqId)?.destroy();
            httpReqs.delete(reqId);
            wsSocks.get(reqId)?.destroy();
            wsSocks.delete(reqId);
        }
    }

    wss.on('connection', (ws) => {
        socket = ws;
        ws.on('message', (raw) => {
            const msg = JSON.parse(String(raw)) as { type?: string; channel?: string; kind?: string; reqId?: string; payload?: any };
            if (msg.type === 'member-hello') {
                ws.send(JSON.stringify({ type: 'member-welcome', sid }));
                return;
            }
            if (
                msg.channel === 'rest' &&
                msg.kind === 'open' &&
                msg.reqId &&
                (msg.payload as { path?: string } | undefined)?.path === '/api/questions'
            ) {
                send({ kind: 'data', channel: 'rest', sid, reqId: msg.reqId, payload: { status: 200, body: JSON.stringify([]) } });
                return;
            }
            if (msg.channel === 'site') handleSite(msg as { kind: string; reqId?: string; payload?: any });
        });
    });

    const ready = new Promise<void>((resolve) => wss.on('listening', () => resolve()));
    return {
        ready,
        get url(): string {
            return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
        },
        openHeaders,
        close(): Promise<void> {
            for (const r of httpReqs.values()) try { r.destroy(); } catch { /* gone */ }
            for (const s of wsSocks.values()) try { s.destroy(); } catch { /* gone */ }
            return new Promise((resolve) => wss.close(() => resolve()));
        },
    };
}

// --- shim client helpers (copied from site-shim.test.ts) -------------------
function connectTunnel(shimPort: number, hostport: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: shimPort, method: 'CONNECT', path: hostport });
        req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`CONNECT ${res.statusCode}`));
                return;
            }
            resolve(socket);
        });
        req.on('error', reject);
        req.end();
    });
}

async function fetchThroughShim(
    shim: SiteShim,
    genHost: string,
    reqPath: string,
    caPem: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const socket = await connectTunnel(shim.port, `${genHost}:443`);
    const tlsSock = tls.connect({ socket, servername: genHost, ca: [caPem] });
    await once(tlsSock, 'secureConnect');
    tlsSock.write(`GET ${reqPath} HTTP/1.1\r\nHost: ${genHost}\r\nConnection: close\r\n\r\n`);
    const chunks: Buffer[] = [];
    for await (const c of tlsSock) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const [head, ...rest] = raw.split('\r\n\r\n');
    const lines = head.split('\r\n');
    const status = Number(lines[0].split(' ')[1]);
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return { status, headers, body: rest.join('\r\n\r\n') };
}

// --- harness lifecycle -----------------------------------------------------
const WS_ID = 'ws-site-1';
const RELAY_CONN_KEY = `ws:${WS_ID}`;

let stub: ReturnType<typeof startSiteRelayStub>;
let mobilePort = 0;
let hostToken = '';
let tailnetConnKey: string | null = null;

beforeEach(async () => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetSiteProxyForTest();
    masterEnabled = true;
    enabledSites.clear();
    lastHttpAuth = undefined;
    await startUpstreams();
    mobilePort = await startMobile();
    hostToken = await pair(mobilePort);
    stub = startSiteRelayStub(() => ({ port: mobilePort, token: hostToken }));
    await stub.ready;
    const res = await connectWorkstation({ workstationId: WS_ID, name: 'Studio Box', relayUrl: stub.url, grant: 'jws.test.grant' });
    expect(res).toEqual({ ok: true, connKey: RELAY_CONN_KEY });
});

afterEach(async () => {
    disconnectConnKey(RELAY_CONN_KEY);
    if (tailnetConnKey) disconnectConnKey(tailnetConnKey);
    tailnetConnKey = null;
    stopMobileServer();
    stopUpstreams();
    await stub.close();
    vi.restoreAllMocks();
    if (appDir) fs.rmSync(appDir, { recursive: true, force: true });
    if (wsRoot) fs.rmSync(wsRoot, { recursive: true, force: true });
});

function makeShim(ca: SessionCa, genMap: Map<string, GenTarget>): Promise<SiteShim> {
    const carrier = getSiteCarrier(RELAY_CONN_KEY);
    if (!carrier) throw new Error('expected a relay site carrier');
    return createSiteShim({ ca, carrier, resolveGen: (h) => genMap.get(h) ?? null });
}

describe('relay site-proxy — carrier routing', () => {
    it('getSiteCarrier returns a carrier for the relay conn and null for an unknown one', () => {
        expect(getSiteCarrier(RELAY_CONN_KEY)).not.toBeNull();
        expect(getSiteCarrier('ws:does-not-exist')).toBeNull();
    });

    it('routes a TAILNET conn to a direct-dial carrier (Bearer injected in main)', async () => {
        const conn = await connectRemote({ ip: '127.0.0.1', port: mobilePort, hostname: 'host' }, currentPin());
        expect(conn.ok).toBe(true);
        tailnetConnKey = conn.connKey!;
        const carrier = getSiteCarrier(tailnetConnKey);
        expect(carrier).not.toBeNull();
        // The tailnet carrier dials the host DIRECTLY, injecting the Bearer in main.
        const call = carrier!.forward({ method: 'GET', path: '/api/site/sitehttp/', headers: {}, body: Readable.from([]) });
        const { status, body } = await call.response;
        const chunks: Buffer[] = [];
        for await (const c of body) chunks.push(c as Buffer);
        expect(status).toBe(200);
        expect(Buffer.concat(chunks).toString()).toBe('host=tynn.test');
    });
});

describe('relay site-proxy — .gen request over the relay (held-until)', () => {
    it('round-trips a .gen GET into handleSiteProxy and back; Bearer injected host-side only', async () => {
        const ca = new SessionCa();
        const genMap = new Map<string, GenTarget>([['tynn.gen', { siteId: 'sitehttp', hostname: 'tynn.test' }]]);
        const shim = await makeShim(ca, genMap);
        try {
            const res = await fetchThroughShim(shim, 'tynn.gen', '/hello?x=1', ca.caPem);
            expect(res.status).toBe(200);
            expect(res.body).toBe('host=tynn.test'); // Host rewritten over the relay
            // The MEMBER's site frame carried NO Authorization — the Bearer is
            // injected in MAIN by the host-side relay dispatch (self-pair).
            const firstOpen = Object.values(stub.openHeaders)[0] ?? {};
            expect(firstOpen['authorization']).toBeUndefined();
            expect(firstOpen['Authorization']).toBeUndefined();
            // The local site never saw the Genie token (stripped by handleSiteProxy).
            expect(lastHttpAuth).toBeUndefined();
            expect(recentAudit().some((e) => e.action === 'site.open')).toBe(true);
        } finally {
            await shim.close();
        }
    });

    it('honours the HOST siteId allowlist over the relay (unresolved siteId → 404)', async () => {
        const ca = new SessionCa();
        // `ghost.gen` passes the shim gate (it IS in genMap) but its siteId is not
        // registered host-side ⇒ handleSiteProxy resolveSite → null → 404.
        const genMap = new Map<string, GenTarget>([['ghost.gen', { siteId: 'ghost', hostname: 'ghost.test' }]]);
        const shim = await makeShim(ca, genMap);
        try {
            const res = await fetchThroughShim(shim, 'ghost.gen', '/', ca.caPem);
            expect(res.status).toBe(404);
        } finally {
            await shim.close();
        }
    });

    it('honours the kill-switch over the relay (isLocked → 423, even on GET)', async () => {
        const ca = new SessionCa();
        const genMap = new Map<string, GenTarget>([['tynn.gen', { siteId: 'sitehttp', hostname: 'tynn.test' }]]);
        const shim = await makeShim(ca, genMap);
        try {
            setLocked(true);
            const res = await fetchThroughShim(shim, 'tynn.gen', '/', ca.caPem);
            expect(res.status).toBe(423);
        } finally {
            setLocked(false);
            await shim.close();
        }
    });
});

describe('relay site-proxy — WebSocket upgrade over the relay', () => {
    it('negotiates a WS upgrade through handleSiteProxyUpgrade and streams the (rewritten) Host frame back', async () => {
        const carrier = getSiteCarrier(RELAY_CONN_KEY);
        expect(carrier).not.toBeNull();
        const key = crypto.randomBytes(16).toString('base64');
        const call = carrier!.upgradeWs({
            path: '/api/site/sitews/socket',
            headers: {
                upgrade: 'websocket',
                connection: 'Upgrade',
                'sec-websocket-version': '13',
                'sec-websocket-key': key,
            },
        });
        const { handshake, socket: duplex } = await call.upgrade;
        // A real 101 whose Sec-WebSocket-Accept was computed from OUR key — proving
        // the upgrade negotiated through the host's real handleSiteProxyUpgrade,
        // over relay `site` frames, with the browser's key preserved end-to-end.
        expect(handshake).toContain(' 101 ');
        const acceptLine = handshake
            .split('\r\n')
            .find((l) => l.toLowerCase().startsWith('sec-websocket-accept'));
        const expectedAccept = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        expect(acceptLine?.split(':')[1].trim()).toBe(expectedAccept);
        // The loopback ws echo sends the Host it saw as the first (server→client,
        // unmasked) WS frame — proving the Host rewrite + server→client bytes flow.
        const inbound: Buffer[] = [];
        duplex.on('data', (c: Buffer) => inbound.push(c));
        await vi.waitFor(() => expect(Buffer.concat(inbound).length).toBeGreaterThanOrEqual(11), { timeout: 3000 });
        const buf = Buffer.concat(inbound);
        const len = buf[1] & 0x7f;
        expect(buf.slice(2, 2 + len).toString('utf8')).toBe('tynn.test');
        duplex.destroy();
    });
});
