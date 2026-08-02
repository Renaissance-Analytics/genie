/**
 * Testing Browser E2E harness.
 *
 * Starts a deterministic loopback dev application, injects it into the real
 * local-site resolver, opens the real Testing Browser, and publishes the page's
 * browser-observed probe through globalThis for Playwright. It is inert unless
 * GENIE_E2E_TUNNEL=1.
 */

import { webContents, type WebContents } from 'electron';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import {
    installTestingBrowserE2ESites,
    LOCAL_CONN_KEY,
    openTestingBrowser,
    testingBrowserContentIdForE2E,
} from '../testing-browser';
import { connectRemote, type EnabledGenSite } from '../remote';
import { currentPin } from '../mobile/auth';
import { mobileServerState, startMobileServer } from '../mobile/server';
import type { MobileDataDeps } from '../mobile/api';
import type { ResolvedSite, SiteProxyDeps } from '../mobile/site-proxy';
import { pendingTunnelLegs, type TunnelProbeShape } from './tunnel-legs';
import { tunnelProbeScript } from './tunnel-probe';

const SITE_ID = 'e2e-app-test';
const VITE_SITE_ID = 'e2e-vite-test';
const NEXT_SITE_ID = 'e2e-next-test';
const REVERB_SITE_ID = 'e2e-reverb-test';
const WORKSPACE_ID = 'e2e-workspace';

/** The origin the Testing Browser must sit on — the `.gen` alias, never the
 *  upstream `.test` vhost the harness opened (genie#29). */
const GEN_ORIGIN = 'https://app.gen';

/**
 * How long the harness converges before publishing whatever state it has.
 *
 * Past this the probe is published with `ready: true` and its residual flags, so
 * a genuinely broken tunnel fails the spec with the REAL diff (exactly which
 * legs never came up) instead of timing out on an opaque poll.
 */
const READY_DEADLINE_MS = 40_000;

/** Floor between re-run kicks, so a fast-failing leg cannot spin the page. */
const RERUN_INTERVAL_MS = 250;

export function isE2ETunnel(): boolean {
    return process.env.GENIE_E2E === '1' && process.env.GENIE_E2E_TUNNEL === '1';
}

/** Optional real-tailnet rung: set to this workstation's Tailscale IP. */
export function isE2ETailscaleTunnel(): boolean {
    return isE2ETunnel() && !!process.env.GENIE_E2E_TAILSCALE_IP;
}

function fixtureHtml(): string {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Genie tunnel E2E fixture</title>
  <link rel="stylesheet" href="https://app.test/absolute.css">
</head>
<body>
  <div id="style-probe">fixture</div>
  <script src="https://app.test/absolute.js"></script>
  <script>
${tunnelProbeScript()}
  </script>
</body>
</html>`;
}

function json(res: http.ServerResponse, value: unknown): void {
    const body = JSON.stringify(value);
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

async function startFixture(): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer((req, res) => {
        const path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
        if (path === '/absolute.css') {
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end('#style-probe { color: rgb(1, 2, 3); }');
            return;
        }
        if (path === '/absolute.js') {
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end('window.__absoluteScriptLoaded = true;');
            return;
        }
        if (path === '/api/bearer') {
            const authorization = req.headers.authorization ?? null;
            json(res, {
                ok: authorization === 'Bearer fixture-application-token',
                authorization,
            });
            return;
        }
        if (path === '/api/cookie') {
            res.setHeader(
                'Set-Cookie',
                'genie_fixture=cookie-ok; Path=/; Domain=app.test; Secure; HttpOnly; SameSite=Lax',
            );
            json(res, { ok: true });
            return;
        }
        if (path === '/api/cookie-check') {
            json(res, { ok: (req.headers.cookie ?? '').includes('genie_fixture=cookie-ok') });
            return;
        }
        if (path === '/redirect') {
            res.writeHead(302, { Location: 'https://app.test/redirect-target' });
            res.end();
            return;
        }
        if (path === '/redirect-target') {
            json(res, { ok: true });
            return;
        }
        if (path === '/api/stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
            });
            res.write('event: fixture\ndata: stream-ok\n\n');
            // Keep the SSE response alive long enough for Chromium to dispatch
            // the event before observing EOF and entering its reconnect path.
            setTimeout(() => res.end(), 250);
            return;
        }
        const body = fixtureHtml();
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
    });
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', (socket) => socket.send('ws-ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
}

async function startViteFixture(): Promise<{ server: http.Server; port: number }> {
    const cors = {
        // Model an ordinary host-local dev server that knows its real `.test`
        // application origin, not Genie's session-only `.gen` alias. The shim
        // maps request Origin to `.test` and this response back to `.gen`.
        'Access-Control-Allow-Origin': 'https://app.test',
        Vary: 'Origin',
    };
    const server = http.createServer((req, res) => {
        const path = new URL(req.url ?? '/', 'http://vite-fixture.invalid').pathname;
        if (path === '/build/manifest.json') {
            const body = JSON.stringify({
                'resources/js/app.ts': {
                    file: 'resources/js/app.ts',
                    isEntry: true,
                    src: 'resources/js/app.ts',
                },
            });
            res.writeHead(200, {
                ...cors,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
        }
        if (path === '/@vite/client') {
            const body =
                'window.__viteClientLoaded = true;\n' +
                'export const viteFixture = true;\n' +
                '//# sourceMappingURL=/@vite/client.map\n';
            res.writeHead(200, {
                ...cors,
                'Content-Type': 'application/javascript',
                'Content-Length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
        }
        if (path === '/@vite/client.map') {
            const body = JSON.stringify({
                version: 3,
                file: '/@vite/client',
                sources: ['/@vite/client'],
                names: [],
                mappings: '',
            });
            res.writeHead(200, {
                ...cors,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
        }
        if (path === '/_next/static/chunks/app.js') {
            const body =
                'window.__nextDevChunkLoaded = true;\n' +
                'export const nextDevFixture = true;\n' +
                '//# sourceMappingURL=app.js.map\n';
            res.writeHead(200, {
                ...cors,
                'Content-Type': 'application/javascript',
                'Content-Length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
        }
        if (path === '/_next/static/chunks/app.js.map') {
            const body = JSON.stringify({
                version: 3,
                file: 'app.js',
                sources: ['webpack://app/page.tsx'],
                names: [],
                mappings: '',
            });
            res.writeHead(200, {
                ...cors,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
        }
        res.writeHead(404, cors);
        res.end();
    });
    const sockets = new WebSocketServer({
        server,
        handleProtocols: (protocols) => (protocols.has('vite-hmr') ? 'vite-hmr' : false),
    });
    sockets.on('connection', (socket, request) => {
        const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
        if (path === '/_next/webpack-hmr') {
            socket.send(JSON.stringify({ action: 'sync', hash: 'e2e' }));
        } else if (path.startsWith('/app/')) {
            socket.send(
                JSON.stringify({
                    event: 'pusher:connection_established',
                    data: JSON.stringify({ socket_id: '1.1', activity_timeout: 30 }),
                }),
            );
        } else {
            socket.send(JSON.stringify({ type: 'connected' }));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
    return { server, port: (server.address() as AddressInfo).port };
}

export async function startTunnelE2EHarness(): Promise<void> {
    if (!isE2ETunnel()) return;
    const handle: Record<string, unknown> = {
        opened: null,
        fixturePort: null,
        probe: null,
    };
    (globalThis as Record<string, unknown>).__GENIE_E2E_TUNNEL__ = handle;
    const fixture = await startFixture();
    const vite = await startViteFixture();
    handle.fixturePort = fixture.port;
    handle.vitePort = vite.port;
    const sites: EnabledGenSite[] = [
        {
            workspaceId: WORKSPACE_ID,
            genName: 'app.gen',
            siteId: SITE_ID,
            hostname: 'app.test',
            scheme: 'http',
            port: fixture.port,
        },
        {
            workspaceId: WORKSPACE_ID,
            genName: 'assets.dev.app.gen',
            siteId: VITE_SITE_ID,
            hostname: 'assets.dev.app.test',
            scheme: 'http',
            port: vite.port,
            loopback: '::1',
            allowedOrigins: ['app.test', 'app.gen'],
        },
        {
            workspaceId: WORKSPACE_ID,
            genName: 'next.dev.app.gen',
            siteId: NEXT_SITE_ID,
            hostname: 'next.dev.app.test',
            scheme: 'http',
            port: vite.port,
            loopback: '::1',
            allowedOrigins: ['app.test', 'app.gen'],
        },
        {
            workspaceId: WORKSPACE_ID,
            genName: 'ws.app.gen',
            siteId: REVERB_SITE_ID,
            hostname: 'ws.app.test',
            scheme: 'http',
            port: vite.port,
            loopback: '::1',
            allowedOrigins: ['app.test', 'app.gen'],
        },
    ];
    let connKey = LOCAL_CONN_KEY;
    if (isE2ETailscaleTunnel()) {
        const byId = new Map<string, ResolvedSite>(
            sites.map((site) => [
                site.siteId,
                {
                    workspaceId: site.workspaceId,
                    hostname: site.hostname,
                    scheme: site.scheme,
                    port: site.port,
                    loopback: site.loopback,
                    allowedOrigins: site.allowedOrigins,
                },
            ]),
        );
        const siteProxy: SiteProxyDeps = {
            resolveSite: (siteId) => byId.get(siteId) ?? null,
        };
        const data = {
            listWorkspaces: () => [{ id: WORKSPACE_ID, project_name: 'Tunnel E2E', path: process.cwd() }],
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
                currentVersion: 'e2e',
                latestVersion: null,
                readyToInstall: false,
            }),
            installUpdate: () => ({ ok: false, reason: 'not-ready' as const }),
            checkUpdate: async () => ({
                state: 'up-to-date',
                currentVersion: 'e2e',
                latestVersion: null,
                readyToInstall: false,
            }),
            listEnabledSites: async () => sites,
        } as unknown as MobileDataDeps;
        await startMobileServer({
            serverVersion: 'e2e-tailnet',
            userDataDir:
                process.env.GENIE_E2E_USERDATA ||
                path.join(os.tmpdir(), `genie-e2e-tailnet-${process.pid}`),
            appDir: __dirname,
            enabled: true,
            configuredPort: () => 0,
            confirmPair: async () => true,
            bindIpOverride: process.env.GENIE_E2E_TAILSCALE_IP,
            data,
            siteProxy,
        });
        const mobile = mobileServerState();
        if (!mobile.running || !mobile.port) throw new Error('tailnet E2E mobile server did not bind');
        const remote = await connectRemote(
            {
                ip: process.env.GENIE_E2E_TAILSCALE_IP!,
                port: mobile.port,
                hostname: 'tailnet-e2e',
            },
            currentPin(),
        );
        if (!remote.ok || !remote.connKey) {
            throw new Error(`tailnet E2E connect failed: ${remote.error ?? 'unknown'}`);
        }
        connKey = remote.connKey;
        handle.tailnet = {
            ip: process.env.GENIE_E2E_TAILSCALE_IP,
            mobilePort: mobile.port,
            connKey,
        };
    } else {
        installTestingBrowserE2ESites(sites);
    }
    const opened = await openTestingBrowser(
        connKey,
        'E2E tunnel fixture',
        'https://app.test/',
    );
    handle.opened = opened;

    // Drive the probe to a READY-STATE rather than sampling it once. `ready` now
    // means "every capability has been observed working over the tunnel" — see
    // pendingTunnelLegs. Until then, re-run the outstanding legs.
    let debuggerConfirmed = false;
    let polling = false;
    let lastRun = 0;
    const deadline = Date.now() + READY_DEADLINE_MS;

    const timer = setInterval(async () => {
        // One outstanding read at a time — a slow `executeJavaScript` must not
        // stack up ticks that then re-kick a pass already in flight.
        if (polling) return;
        const id = testingBrowserContentIdForE2E();
        const contents = id ? webContents.fromId(id) : null;
        if (!contents || contents.isDestroyed()) return;
        polling = true;
        try {
            if (!debuggerConfirmed) debuggerConfirmed = await confirmDebuggerOrigin(contents);
            const probe = (await contents.executeJavaScript(
                'window.__tunnelProbe ? JSON.parse(JSON.stringify(window.__tunnelProbe)) : null',
                true,
            )) as (TunnelProbeShape & Record<string, unknown>) | null;
            if (!probe) return; // page not parsed yet
            const pending = pendingTunnelLegs(probe);
            probe.ready = pending.length === 0 || Date.now() >= deadline;
            if (isE2ETailscaleTunnel()) probe.transport = 'tailscale';
            handle.probe = probe;
            if (probe.ready) {
                clearInterval(timer);
                return;
            }
            // The `debugger` leg is main-side (confirmDebuggerOrigin retries it);
            // everything else is re-run in the page.
            const retry = pending.filter((leg) => leg !== 'debugger');
            if (retry.length && !probe.running && Date.now() - lastRun >= RERUN_INTERVAL_MS) {
                lastRun = Date.now();
                await contents.executeJavaScript(
                    `window.__tunnelRun(${JSON.stringify(retry)})`,
                    true,
                );
            }
        } catch {
            // Navigation/TLS handshake may still be in flight; poll again.
        } finally {
            polling = false;
        }
    }, 100);
    timer.unref?.();
}

/**
 * Confirm over the DevTools protocol that the page really sits on the `.gen`
 * origin, and record it on the probe. Returns false while the answer is not yet
 * trustworthy — debugger not attached, page mid-navigation, probe not published —
 * so the caller RETRIES.
 *
 * The old harness did this exactly once, keyed off `debugger.isAttached()`. The
 * attach succeeded on the first 100 ms tick, i.e. while the very first navigation
 * was still in flight, so `location.origin` could be sampled as `about:blank` and
 * written as a permanent `false`; and any throw from the write (probe not defined
 * yet) still left `isAttached()` true, so the block never ran again. Either way
 * `vite.debugger` stuck false and the spec failed on a warm-up artifact.
 */
async function confirmDebuggerOrigin(contents: WebContents): Promise<boolean> {
    if (!contents.debugger.isAttached()) {
        contents.debugger.attach('1.3');
        await contents.debugger.sendCommand('Runtime.enable');
    }
    const evaluated = await contents.debugger.sendCommand('Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true,
    });
    if (evaluated?.result?.value !== GEN_ORIGIN) return false;
    await contents.executeJavaScript('window.__tunnelProbe.vite.debugger = true', true);
    return true;
}
