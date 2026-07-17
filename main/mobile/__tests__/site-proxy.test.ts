import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
    startMobileServer,
    stopMobileServer,
    mobileServerState,
    setLocked,
} from '../server';
import { _resetAuthForTest, currentPin } from '../auth';
import { _resetAuditForTest, recentAudit } from '../audit';
import { _resetSiteProxyForTest, type ResolvedSite, type SiteProxyDeps } from '../site-proxy';
import type { MobileDataDeps } from '../api';

/**
 * Serve-local-sites Phase C — over-the-wire test for the HOST reverse proxy.
 *
 * We bind the REAL mobile server to 127.0.0.1 (bindIpOverride, no tailnet) and
 * drive the actual http + ws stack through `/api/site/<siteId>/…`, standing up
 * FAKE loopback "sites" (a plain-http echo, a self-signed-TLS echo, and a ws
 * echo) that report back the `Host` header + SNI they received. The tunnel
 * settings/allowlist are INJECTED as `SiteProxyDeps` (no real sqlite), exactly
 * like Phase B's MobileDataDeps. We assert:
 *   (a) an authed request returns the site's content and the upstream saw
 *       `Host: tynn.test` (the Host-rewrite crux) with NO leaked Authorization;
 *   (b) an https site is TLS-terminated on loopback with SNI = the hostname;
 *   (c) `isLocked()` returns 423 even on GET; unauthed returns 401;
 *   (d) an unknown/disabled siteId is refused; the master switch off is refused;
 *   (e) an SSRF attempt (a raw host:port as the siteId) never reaches an
 *       un-allowlisted loopback service;
 *   (f) a WebSocket upgrade is proxied end-to-end (Host rewritten, echoed back);
 *   (g) the http re-serve applies the Location / HSTS / Secure-cookie rewrites.
 */

// A long-lived (100y) self-signed cert for CN/SAN tynn.test — the proxy dials
// loopback with rejectUnauthorized:false, so it need not be trusted; it just
// lets the fake https upstream complete a handshake and record the SNI.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDMjCCAhqgAwIBAgIULF/syeRZbfjSyYcMTOPCKYgsnjswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJdHlubi50ZXN0MCAXDTI2MDcwMzIzMjcyNloYDzIxMjYw
NjA5MjMyNzI2WjAUMRIwEAYDVQQDDAl0eW5uLnRlc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDTj+J24kMh9gKWSsioYdC1aWbINuYxtBnBm+Sj8TQq
jxpkEiTCKZUp/JQKQYk2zsB33GWIgFkXILVHtbQZ5jw/ASFs7Tmeza+IZEn0S1S2
ykLQ8QLg4LHHDGavmWBop3YBg0HCIDndgZVrVZCRyjMJ+Pa8da9+7KTGaWdrgC7/
ofrBBqAdjHyx6bOViqUpgwlNEWzr4RFbsQbuXgcXxSljT3UdK0cNEzq1GlE+hLGv
Rdx7QYTReggC5exzRwPnprNA2M5bs0usB4njBzUzW2gq3SOg65BLPlhkCxhtq/Wq
j/DpJLjbR2veSlI/bMrfCs7HKQBfgTWv3g/M+5dmie03AgMBAAGjejB4MB0GA1Ud
DgQWBBT5Ci5yhX4vM9rKLxV9cNxYqgYtzTAfBgNVHSMEGDAWgBT5Ci5yhX4vM9rK
LxV9cNxYqgYtzTAPBgNVHRMBAf8EBTADAQH/MCUGA1UdEQQeMByCCXR5bm4udGVz
dIIJbG9jYWxob3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQBT9xjkclqJ8N2J
HN70gaMPB/3n6+dZoXbR5MVyBJq1QqyARznrQwxT1ysib+u1/opnfLIBkFfBDIVa
nlOLXLTnZ2z1zeSBfSFEAizKx9n7zhH5Y6wN3UhXZCrMhkKsBq0emPVk62zsVhSl
Nk1LFHgs6nkQV3ZrZrpGaC5lsVJrc57/gSMTiQQp+rqPDNQ7TTm443WJvNQh6474
k4vo6G6jdRVUJCDjMuOPYdTPdJjoV9k8V9ANHAq7yY1rmTaplIdeWv9KIf+Yqc6v
QQOzemqDnp9vUXTBUXrGXcohbxwr3x853Vb/bO7GWdTzanVs7ouYUPoKti8iQeTr
xsyQjUWF
-----END CERTIFICATE-----
`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDTj+J24kMh9gKW
SsioYdC1aWbINuYxtBnBm+Sj8TQqjxpkEiTCKZUp/JQKQYk2zsB33GWIgFkXILVH
tbQZ5jw/ASFs7Tmeza+IZEn0S1S2ykLQ8QLg4LHHDGavmWBop3YBg0HCIDndgZVr
VZCRyjMJ+Pa8da9+7KTGaWdrgC7/ofrBBqAdjHyx6bOViqUpgwlNEWzr4RFbsQbu
XgcXxSljT3UdK0cNEzq1GlE+hLGvRdx7QYTReggC5exzRwPnprNA2M5bs0usB4nj
BzUzW2gq3SOg65BLPlhkCxhtq/Wqj/DpJLjbR2veSlI/bMrfCs7HKQBfgTWv3g/M
+5dmie03AgMBAAECggEAY+SV8T1fpmrzCMTR3xOkiOv2MIYfhgt8d9rkh/ZNg+Ti
+KpKefVJbbRJsFgGcn8ICPBjbqLvrghvICdvHSWFf9hIUJbodI+5GKUF+FgTbWWu
S9ro2Yau2oYD/Fjm2TNs+ETiKUevGuRjSXVy2CvJkqVf11eYIE2bdeXyA6PYTTHx
dQs/bQMQhxPJt7cGOMd1LorlVbtF4JPeZGv2jXRElyE8iD0iYndF3M0xjZJgssAl
ZCsr/3yjqzQWvQoopUKRDRwFiUrPBcZzY213OcdhbPWuB4BqOgKOXYXM8HleWuXo
jgjD8OaQGibVXN+zOV/EjleEjg7xvYf3QeELtArfhQKBgQD7i7UJ8NIZGeCeYn6b
4nq0Zv55JC7VoGrDojW88P//u24lwYgzmO7v4F6MuxNMZQO2hLc0OWgol4zbwRkm
pUnARlCPV8xskOkeSwHm9wWa8SHWxT6B7DPDtUQLdNvBa7vK1RrOkkJ+K8IsuIka
l5mR7QOy7PgKVz9Yst8g2zFRmwKBgQDXTuz57li3CozWnGZsDIiXKhnrRkU0Rlf2
g7geMbd3c1todDTBlJDlWeSpYm48wYznq3nQLU+1AW6qip5+a26Yw/8vH+T3VRU8
bVJMzF6C5SHhPSjuqoQ+I7enuNlY1pnHpNUDtNbwh3Ft3PwVoSQcOiXO2vCECBcR
EAHrOnYqlQKBgE2/QJVx+X4IoYRSrQ9BUOuxabXHmTIuAtG0sSdU1csVA1ZoGtDX
1AIQNykIKU7TafJf0sAxfiANt1u0szFepQzorr2fRW/I2kSiqlPYxcK+BNd833UI
rHcw73cbB1EhG0n10/NFAYg9viZUYwv1D2Iq/5mt5HxNuyaPIqflF7lBAoGAOy8/
5wgErPQieM/vO55KYbs5+rmLRm5bubDFiM9DznsQUms3IUtUdSc7uvAKu3q83+X8
CySZd3kYUZrfLIMdmLKvz+VljDOALecjK2c2R6bypDaqrMiEp4wr7NfcLxZ2mTGP
OICaYO3qWTfYt51fDr9RK0Z1vOV4acFLtbyRRO0CgYBlZtyE311eJG53mPEyx8UQ
2CtL452JNRrsNzFqbpJVse1JGrZKJvPXNpWNpUy3apADkVMJQ2kAxnlwHvIQRM/y
IXnfYkdMpSOxAHTGsYRCtvqgRvvrHvozAhyzNseBvPvDILYpC76qiSGqaXi142bz
xGjX3WqZONEmsY83ZYhZwA==
-----END PRIVATE KEY-----
`;

const HOSTNAME = 'tynn.test';

// --- test-controlled proxy state (the injected allowlist) ------------------
let masterEnabled = true;
const enabledSites = new Map<string, ResolvedSite>();

const siteProxy: SiteProxyDeps = {
    localSitesEnabled: () => masterEnabled,
    resolveSite: (siteId) => enabledSites.get(siteId) ?? null,
};

// --- fake loopback upstreams ------------------------------------------------
let httpUpstream: http.Server;
let httpsUpstream: https.Server;
let wsHttp: http.Server;
let wsUpstream: WebSocketServer;
let secretServer: http.Server;

let lastHttpAuth: string | undefined; // Authorization the http upstream saw (must be undefined)
let lastSni: string | undefined; // SNI the https upstream saw (must be HOSTNAME)
let secretHits = 0; // requests that reached the un-allowlisted service (must stay 0)

/** A shared request handler for the http + https echo upstreams: report back the
 *  `Host` header, and a `/redir` endpoint exercising the header rewrites. */
function echoHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url?.startsWith('/redir')) {
        res.writeHead(302, {
            // Absolute same-host redirect → must be rewritten to the proxy origin.
            Location: 'https://tynn.test/next?q=1',
            'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
            'Set-Cookie': ['sid=abc; Path=/; Secure; HttpOnly', 'theme=dark; Secure'],
        });
        res.end();
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`host=${req.headers.host}`);
}

function listen(server: http.Server | https.Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
}

async function startUpstreams(): Promise<void> {
    httpUpstream = http.createServer((req, res) => {
        lastHttpAuth = req.headers.authorization;
        echoHandler(req, res);
    });
    const ctx = tls.createSecureContext({ cert: TEST_CERT, key: TEST_KEY });
    httpsUpstream = https.createServer(
        {
            cert: TEST_CERT,
            key: TEST_KEY,
            SNICallback: (servername, cb) => {
                lastSni = servername;
                cb(null, ctx);
            },
        },
        echoHandler,
    );
    wsHttp = http.createServer();
    wsUpstream = new WebSocketServer({ server: wsHttp });
    wsUpstream.on('connection', (sock, req) => {
        // First frame: echo the Host header the proxy rewrote (proves the crux).
        sock.send(String(req.headers.host));
        sock.on('message', (m) => sock.send(m.toString()));
    });
    secretServer = http.createServer((_req, res) => {
        secretHits += 1;
        res.end('secret');
    });

    const httpPort = await listen(httpUpstream);
    const httpsPort = await listen(httpsUpstream);
    const wsPort = await listen(wsHttp);
    const secretPort = await listen(secretServer);

    enabledSites.set('sitehttp', { workspaceId: 'workspace-1', hostname: HOSTNAME, scheme: 'http', port: httpPort });
    enabledSites.set('sitehttps', { workspaceId: 'workspace-1', hostname: HOSTNAME, scheme: 'https', port: httpsPort });
    enabledSites.set('sitews', { workspaceId: 'workspace-1', hostname: HOSTNAME, scheme: 'http', port: wsPort });
    // secretServer is intentionally NOT registered — it models an SSRF target.
    secretTarget = `127.0.0.1:${secretPort}`;
}

let secretTarget = '';

function stopUpstreams(): void {
    wsUpstream?.close();
    for (const s of [httpUpstream, httpsUpstream, wsHttp, secretServer]) {
        try {
            s?.close();
        } catch {
            /* already closed */
        }
    }
}

// --- mobile-server harness --------------------------------------------------
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
        createAgentTerminal: () => ({ id: 't', scrollback: '', existing: false }),
        killTerminalById: () => true,
        writeToTerminal: () => true,
        readTerminalOutput: () => ({ data: '', cursor: 0, dropped: false }),
        getScrollback: () => '',
        resize: () => true,
        listPendingQuestions: () => [],
        answerPendingQuestion: () => true,
        updateStatus: () => ({
            state: 'up-to-date',
            currentVersion: '0.0.0-test',
            latestVersion: null,
            readyToInstall: false,
        }),
        installUpdate: () => ({ ok: false, reason: 'not-ready' as const }),
        checkUpdate: async () => ({
            state: 'up-to-date',
            currentVersion: '0.0.0-test',
            latestVersion: null,
            readyToInstall: false,
        }),
    }) as unknown as MobileDataDeps;

async function start(): Promise<number> {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-siteproxy-app-'));
    fs.writeFileSync(path.join(appDir, 'mobile.html'), '<!doctype html><html><head></head><body>m</body></html>');
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-siteproxy-ws-'));
    await startMobileServer({
        serverVersion: '0.0.0-test',
        userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'genie-siteproxy-ud-')),
        appDir,
        enabled: true,
        configuredPort: () => 0, // ephemeral
        data: dataDeps(),
        siteProxy,
        confirmPair: async () => true,
        bindIpOverride: '127.0.0.1',
    });
    const st = mobileServerState();
    if (!st.running || !st.port) throw new Error('server did not bind');
    return st.port;
}

interface RawResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

function rawReq(
    port: number,
    method: string,
    pathname: string,
    opts: { token?: string } = {},
): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
        const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        r.on('error', reject);
        r.end();
    });
}

async function pair(port: number): Promise<string> {
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

beforeEach(async () => {
    _resetAuthForTest();
    _resetAuditForTest();
    _resetSiteProxyForTest();
    masterEnabled = true;
    enabledSites.clear();
    lastHttpAuth = undefined;
    lastSni = undefined;
    secretHits = 0;
    await startUpstreams();
});

afterEach(() => {
    stopMobileServer();
    stopUpstreams();
    if (appDir) fs.rmSync(appDir, { recursive: true, force: true });
    if (wsRoot) fs.rmSync(wsRoot, { recursive: true, force: true });
});

describe('site-proxy (Phase C, over the wire)', () => {
    it('(a) proxies an authed http request, rewriting Host and never leaking the token', async () => {
        const port = await start();
        const token = await pair(port);
        const res = await rawReq(port, 'GET', '/api/site/sitehttp/hello?x=1', { token });
        expect(res.status).toBe(200);
        // The upstream vhost saw Host: tynn.test regardless of the proxy host:port.
        expect(res.body).toBe(`host=${HOSTNAME}`);
        // The inbound Genie Bearer was stripped — never forwarded to the site.
        expect(lastHttpAuth).toBeUndefined();
        // First hit per site is audited.
        expect(recentAudit().some((e) => e.action === 'site.open')).toBe(true);
    });

    it('(b) terminates local TLS on loopback with SNI = the hostname (https site)', async () => {
        const port = await start();
        const token = await pair(port);
        const res = await rawReq(port, 'GET', '/api/site/sitehttps/', { token });
        expect(res.status).toBe(200);
        expect(res.body).toBe(`host=${HOSTNAME}`);
        // The proxy TLS-connected as a client with SNI = the vhost name.
        expect(lastSni).toBe(HOSTNAME);
    });

    it('(c) refuses an unauthed request (401) and everything while locked (423, even GET)', async () => {
        const port = await start();
        const token = await pair(port);
        const noTok = await rawReq(port, 'GET', '/api/site/sitehttp/', {});
        expect(noTok.status).toBe(401);
        setLocked(true);
        const locked = await rawReq(port, 'GET', '/api/site/sitehttp/', { token });
        expect(locked.status).toBe(423); // kill-switch covers reads too
        setLocked(false);
    });

    it('(d) refuses an unknown/disabled siteId (404) and the master switch off (403)', async () => {
        const port = await start();
        const token = await pair(port);
        const unknown = await rawReq(port, 'GET', '/api/site/nope/', { token });
        expect(unknown.status).toBe(404);
        masterEnabled = false; // local_sites_enabled off
        const masterOff = await rawReq(port, 'GET', '/api/site/sitehttp/', { token });
        expect(masterOff.status).toBe(403);
    });

    it('(e) refuses an SSRF attempt and never reaches an un-allowlisted loopback service', async () => {
        const port = await start();
        const token = await pair(port);
        // Dressing the raw loopback target up as a siteId does not reach it — the
        // opaque id must resolve via the injected allowlist, which it never will.
        const res = await rawReq(port, 'GET', `/api/site/${secretTarget}/`, { token });
        expect(res.status).toBe(404);
        expect(secretHits).toBe(0);
    });

    it('(f) proxies a WebSocket upgrade end-to-end (Host rewritten, echoed back)', async () => {
        const port = await start();
        const token = await pair(port);
        const frames: string[] = [];
        const ws = await new Promise<WebSocket>((resolve, reject) => {
            const sock = new WebSocket(
                `ws://127.0.0.1:${port}/api/site/sitews/socket?__genie_token=${token}`,
                { origin: 'http://127.0.0.1' },
            );
            sock.on('message', (m) => frames.push(m.toString()));
            sock.once('open', () => resolve(sock));
            sock.once('error', reject);
        });
        // First frame is the Host the upstream saw — proves the WS Host rewrite.
        await new Promise((r) => setTimeout(r, 40));
        expect(frames[0]).toBe(HOSTNAME);
        // Round-trip a message through the piped sockets.
        ws.send('ping');
        await new Promise((r) => setTimeout(r, 40));
        expect(frames).toContain('ping');
        ws.close();
    });

    it('(f2) rejects a WS upgrade without a token (401)', async () => {
        const port = await start();
        await expect(
            new Promise((resolve, reject) => {
                const sock = new WebSocket(`ws://127.0.0.1:${port}/api/site/sitews/socket`, {
                    origin: 'http://127.0.0.1',
                });
                sock.once('open', () => resolve(sock));
                sock.once('error', reject);
            }),
        ).rejects.toBeTruthy();
    });

    it('(g) applies the http re-serve rewrites: Location, HSTS strip, Secure-cookie clear', async () => {
        const port = await start();
        const token = await pair(port);
        const res = await rawReq(port, 'GET', '/api/site/sitehttp/redir', { token });
        expect(res.status).toBe(302);
        // Location: https://tynn.test/next?q=1 → the proxy origin + site prefix,
        // scheme downgraded to the proxy's http.
        expect(res.headers['location']).toBe(
            `http://127.0.0.1:${port}/api/site/sitehttp/next?q=1`,
        );
        // HSTS is stripped (it's about tynn.test, not the ephemeral proxy origin).
        expect(res.headers['strict-transport-security']).toBeUndefined();
        // The Secure flag is cleared on every Set-Cookie (re-served over http).
        const cookies = res.headers['set-cookie'] ?? [];
        expect(cookies.length).toBe(2);
        for (const c of cookies) expect(/;\s*secure/i.test(c)).toBe(false);
    });
});
