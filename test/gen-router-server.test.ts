import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GenRouterServer } from '../src/main/gen-router-server.js';

/**
 * THE `.gen` FRONT DOOR (§6.6) — the byte-moving half. One loopback listener; every request is
 * resolved by `core/gen-router.ts` and proxied to the site's loopback target with the `.gen` Host
 * kept, or answered with a page that names the problem. WebSocket upgrades pass through, because a
 * Vite dev server without HMR is not the dev server the person started.
 *
 * Real sockets, in-process, on the test machine — never on the owner's desktop.
 */

const servers: Array<Server | GenRouterServer> = [];
afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function target(handler: Parameters<typeof createServer>[1]): Promise<{ port: number; server: Server }> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as { port: number }).port, server };
}

function get(port: number, path: string, host: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => { body += c.toString(); });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('proxying', () => {
    it('a request for a served .gen host reaches the site with the .gen Host header and the path intact, and the answer comes back whole', async () => {
        const seen: Array<{ host: string | undefined; url: string | undefined }> = [];
        const site = await target((req, res) => {
            seen.push({ host: req.headers.host, url: req.url });
            res.writeHead(200, { 'content-type': 'text/plain', 'x-site': 'tynn' });
            res.end('hello from tynn');
        });
        const door = new GenRouterServer(() => [{ host: 'tynn.gen', target: `127.0.0.1:${site.port}` }]);
        servers.push(door);
        const port = await door.listen();

        const r = await get(port, '/dashboard?x=1', 'tynn.gen');
        expect(r.status).toBe(200);
        expect(r.body).toBe('hello from tynn');
        expect(r.headers['x-site']).toBe('tynn');
        expect(seen).toEqual([{ host: 'tynn.gen', url: '/dashboard?x=1' }]);
    });

    it('a .gen host nobody serves → 404 with a page that NAMES the host; a non-.gen host → 421 and nothing proxied', async () => {
        const door = new GenRouterServer(() => []);
        servers.push(door);
        const port = await door.listen();
        const missing = await get(port, '/', 'ghost.gen');
        expect(missing.status).toBe(404);
        expect(missing.body).toContain('ghost.gen');
        const notGen = await get(port, '/', 'example.com');
        expect(notGen.status).toBe(421);
    });

    it('a site whose process is gone → 502 with a page that names the site, not a hang', async () => {
        const dead = await target((_req, res) => res.end('x'));
        const port = dead.port;
        await new Promise<void>((r) => dead.server.close(() => r()));
        servers.splice(servers.indexOf(dead.server), 1);
        const door = new GenRouterServer(() => [{ host: 'tynn.gen', target: `127.0.0.1:${port}` }]);
        servers.push(door);
        const doorPort = await door.listen();
        const r = await get(doorPort, '/', 'tynn.gen');
        expect(r.status).toBe(502);
        expect(r.body).toContain('tynn.gen');
    });

    it('binds loopback only: the listen address is 127.0.0.1', async () => {
        const door = new GenRouterServer(() => []);
        servers.push(door);
        await door.listen();
        expect(door.address()?.address).toBe('127.0.0.1');
    });
});

describe('WebSocket upgrade passes through', () => {
    it('an Upgrade request reaches the site and its 101 comes back on the same socket', async () => {
        const site = createServer();
        servers.push(site);
        site.on('upgrade', (req, socket) => {
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Host: ${req.headers.host}\r\n\r\n`);
            socket.end();
        });
        await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
        const sitePort = (site.address() as { port: number }).port;
        const door = new GenRouterServer(() => [{ host: 'tynn.gen', target: `127.0.0.1:${sitePort}` }]);
        servers.push(door);
        const port = await door.listen();

        const reply = await new Promise<string>((resolve, reject) => {
            const sock = connect(port, '127.0.0.1', () => {
                sock.write('GET /vite-hmr HTTP/1.1\r\nHost: tynn.gen\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n');
            });
            let data = '';
            sock.on('data', (c) => { data += c.toString(); });
            sock.on('end', () => resolve(data));
            sock.on('error', reject);
        });
        expect(reply).toContain('101 Switching Protocols');
        expect(reply).toContain('X-Seen-Host: tynn.gen');
    });
});
