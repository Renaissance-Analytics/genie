/**
 * Testing Browser E2E harness.
 *
 * Starts a deterministic loopback dev application, injects it into the real
 * local-site resolver, opens the real Testing Browser, and publishes the page's
 * browser-observed probe through globalThis for Playwright. It is inert unless
 * GENIE_E2E_TUNNEL=1.
 */

import { webContents } from 'electron';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import {
    installTestingBrowserE2ESites,
    LOCAL_CONN_KEY,
    openTestingBrowser,
    testingBrowserContentIdForE2E,
} from '../testing-browser';

const SITE_ID = 'e2e-app-test';
const VITE_SITE_ID = 'e2e-vite-test';
const NEXT_SITE_ID = 'e2e-next-test';
const REVERB_SITE_ID = 'e2e-reverb-test';
const WORKSPACE_ID = 'e2e-workspace';

export function isE2ETunnel(): boolean {
    return process.env.GENIE_E2E === '1' && process.env.GENIE_E2E_TUNNEL === '1';
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
  window.__tunnelProbe = {
    ready: false,
    origin: location.origin,
    absoluteScript: false,
    absoluteStyle: false,
    bearer: { ok: false, authorization: null },
    cookie: false,
    redirect: { ok: false, url: '' },
    stream: false,
    websocket: false,
    vite: { manifest: false, module: false, sourceMap: false, hmr: false, debugger: false },
    next: { module: false, sourceMap: false, fastRefresh: false },
    reverb: false,
    errors: [],
  };
  const p = window.__tunnelProbe;
  const attempt = async (name, fn) => {
    try { await fn(); } catch (error) { p.errors.push(name + ': ' + String(error)); }
  };
  (async () => {
    p.absoluteScript = window.__absoluteScriptLoaded === true;
    p.absoluteStyle = getComputedStyle(document.getElementById('style-probe')).color === 'rgb(1, 2, 3)';
    await attempt('bearer', async () => {
      const response = await fetch('/api/bearer', {
        headers: { Authorization: 'Bearer fixture-application-token' },
      });
      p.bearer = await response.json();
    });
    await attempt('cookie', async () => {
      await fetch('/api/cookie', { credentials: 'include' });
      p.cookie = (await (await fetch('/api/cookie-check', { credentials: 'include' })).json()).ok;
    });
    await attempt('redirect', async () => {
      const response = await fetch('/redirect');
      const body = await response.json();
      p.redirect = { ok: body.ok === true, url: response.url };
    });
    await attempt('stream', () => new Promise((resolve, reject) => {
      const events = new EventSource('/api/stream');
      const timeout = setTimeout(() => { events.close(); reject(new Error('timeout')); }, 3000);
      events.addEventListener('fixture', (event) => {
        clearTimeout(timeout);
        events.close();
        p.stream = event.data === 'stream-ok';
        resolve();
      });
      events.onerror = () => { clearTimeout(timeout); events.close(); reject(new Error('failed')); };
    }));
    await attempt('websocket', () => new Promise((resolve, reject) => {
      const socket = new WebSocket('wss://' + location.host + '/ws');
      const timeout = setTimeout(() => { socket.close(); reject(new Error('timeout')); }, 3000);
      socket.onmessage = (event) => {
        clearTimeout(timeout);
        p.websocket = event.data === 'ws-ok';
        socket.close();
        resolve();
      };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('failed')); };
    }));
    await attempt('vite-manifest', async () => {
      const response = await fetch('https://assets.dev.app.test/build/manifest.json');
      const manifest = await response.json();
      p.vite.manifest = manifest['resources/js/app.ts'].isEntry === true;
    });
    await attempt('vite-module', async () => {
      await import('https://assets.dev.app.test/@vite/client');
      p.vite.module = window.__viteClientLoaded === true;
      const response = await fetch('https://assets.dev.app.test/@vite/client.map');
      const sourceMap = await response.json();
      p.vite.sourceMap = sourceMap.sources.includes('/@vite/client');
    });
    await attempt('vite-hmr', () => new Promise((resolve, reject) => {
      const socket = new WebSocket('wss://assets.dev.app.test/hmr', 'vite-hmr');
      const timeout = setTimeout(() => { socket.close(); reject(new Error('timeout')); }, 3000);
      socket.onmessage = (event) => {
        clearTimeout(timeout);
        const message = JSON.parse(String(event.data));
        p.vite.hmr = message.type === 'connected';
        socket.close();
        resolve();
      };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('failed')); };
    }));
    await attempt('next-module', async () => {
      await import('https://next.dev.app.test/_next/static/chunks/app.js');
      p.next.module = window.__nextDevChunkLoaded === true;
      const response = await fetch('https://next.dev.app.test/_next/static/chunks/app.js.map');
      const sourceMap = await response.json();
      p.next.sourceMap = sourceMap.sources.includes('webpack://app/page.tsx');
    });
    await attempt('next-fast-refresh', () => new Promise((resolve, reject) => {
      const socket = new WebSocket('wss://next.dev.app.test/_next/webpack-hmr');
      const timeout = setTimeout(() => { socket.close(); reject(new Error('timeout')); }, 3000);
      socket.onmessage = (event) => {
        clearTimeout(timeout);
        const message = JSON.parse(String(event.data));
        p.next.fastRefresh = message.action === 'sync';
        socket.close();
        resolve();
      };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('failed')); };
    }));
    await attempt('reverb', () => new Promise((resolve, reject) => {
      const socket = new WebSocket('wss://ws.app.test/app/e2e-key?protocol=7&client=js');
      const timeout = setTimeout(() => { socket.close(); reject(new Error('timeout')); }, 3000);
      socket.onmessage = (event) => {
        clearTimeout(timeout);
        const message = JSON.parse(String(event.data));
        p.reverb = message.event === 'pusher:connection_established';
        socket.close();
        resolve();
      };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('failed')); };
    }));
    p.ready = true;
  })();
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
    installTestingBrowserE2ESites([
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
        },
        {
            workspaceId: WORKSPACE_ID,
            genName: 'next.dev.app.gen',
            siteId: NEXT_SITE_ID,
            hostname: 'next.dev.app.test',
            scheme: 'http',
            port: vite.port,
            loopback: '::1',
        },
        {
            workspaceId: WORKSPACE_ID,
            genName: 'ws.app.gen',
            siteId: REVERB_SITE_ID,
            hostname: 'ws.app.test',
            scheme: 'http',
            port: vite.port,
            loopback: '::1',
        },
    ]);
    const opened = await openTestingBrowser(
        LOCAL_CONN_KEY,
        'E2E tunnel fixture',
        'https://app.test/',
    );
    handle.opened = opened;

    const timer = setInterval(async () => {
        const id = testingBrowserContentIdForE2E();
        const contents = id ? webContents.fromId(id) : null;
        if (!contents || contents.isDestroyed()) return;
        try {
            if (!contents.debugger.isAttached()) {
                contents.debugger.attach('1.3');
                await contents.debugger.sendCommand('Runtime.enable');
                const evaluated = await contents.debugger.sendCommand('Runtime.evaluate', {
                    expression: 'location.origin',
                    returnByValue: true,
                });
                await contents.executeJavaScript(
                    `window.__tunnelProbe.vite.debugger = ${
                        evaluated?.result?.value === 'https://app.test'
                    }`,
                    true,
                );
            }
            const probe = await contents.executeJavaScript(
                'window.__tunnelProbe ? JSON.parse(JSON.stringify(window.__tunnelProbe)) : null',
                true,
            );
            handle.probe = probe;
            if (probe?.ready) clearInterval(timer);
        } catch {
            // Navigation/TLS handshake may still be in flight; poll again.
        }
    }, 100);
    timer.unref?.();
}
