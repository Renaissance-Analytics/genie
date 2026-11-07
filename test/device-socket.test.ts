import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { deviceSocket } from '../src/main/device-socket.js';
import { DEVICE_FRAME_LIMIT_BYTES, DeviceLinkService, type DeviceLinkEvent } from '../src/main/device-link-service.js';
import { issueCa, issueLeaf, type IssuedPem } from '../src/main/x509.js';

/**
 * ANOTHER MACHINE'S SOCKET TRUSTS WHAT THE HOST'S HTTPS TRUSTS (P3.4 cut e). Chromium read the OS store for a window; Node's own WebSocket does not, so a machine behind a
 * company's root would have stopped answering. This is the same set as host-https-fetch.ts, Node's bundled roots and the OS store, and verification cannot be turned off.
 */

const DAY = 86_400_000;
const NOW = Date.now();
const newCa = (commonName: string): IssuedPem => issueCa({ commonName, organization: 'Genie Test', notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 30 * DAY) });
const leafOf = (ca: IssuedPem, name = 'localhost'): IssuedPem => issueLeaf(ca, [name], new Date(NOW - DAY), new Date(NOW + 30 * DAY));
const TRUSTED = newCa('Trusted Test CA');
const STRANGER = newCa('Nobody You Know');
const roots = (): readonly string[] => [TRUSTED.certPem];

const open: Array<HttpServer | HttpsServer> = [];
afterEach(async () => {
    for (const server of open.splice(0)) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

async function machine(server: HttpServer | HttpsServer) {
    const seen = { connections: 0, frames: [] as string[] };
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => {
        seen.connections += 1;
        socket.on('message', (data) => { seen.frames.push(String(data)); socket.send('hello back'); });
    });
    open.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { seen, port: (server.address() as AddressInfo).port };
}
const tlsMachine = (ca: IssuedPem, name = 'localhost') => { const leaf = leafOf(ca, name); return machine(createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem })); };

/** What became of a dial: it opened, or it ended before it did. */
function outcome(socket: ReturnType<typeof deviceSocket>): Promise<'open' | 'refused'> {
    return new Promise((resolve) => {
        socket.onopen = () => resolve('open');
        socket.onerror = () => resolve('refused');
        socket.onclose = () => resolve('refused');
    });
}

describe('the roots', () => {
    it('a machine whose certificate chains to a trusted root connects, and text frames arrive as text', async () => {
        const m = await tlsMachine(TRUSTED);
        const socket = deviceSocket(`wss://localhost:${m.port}/genie`, { machineRoots: roots });
        expect(await outcome(socket)).toBe('open');
        const heard = new Promise<unknown>((resolve) => { socket.onmessage = (ev) => resolve(ev.data); });
        socket.send('hello');
        expect(await heard).toBe('hello back');
        expect(m.seen.frames).toEqual(['hello']);
        socket.close();
    });

    it('a machine nobody vouches for is refused, and hears nothing', async () => {
        const m = await tlsMachine(STRANGER);
        expect(await outcome(deviceSocket(`wss://localhost:${m.port}/genie`, { machineRoots: roots }))).toBe('refused');
        expect(m.seen.connections).toBe(0);
    });

    it('NODE_TLS_REJECT_UNAUTHORIZED=0 in its environment turns nothing off', async () => {
        const m = await tlsMachine(STRANGER);
        const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        try {
            expect(await outcome(deviceSocket(`wss://localhost:${m.port}/genie`, { machineRoots: roots }))).toBe('refused');
            expect(m.seen.connections).toBe(0);
        } finally {
            if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
        }
    });

    it('a trusted root for another name is refused: the name is checked as well as the chain', async () => {
        const m = await tlsMachine(TRUSTED, 'studio.example');
        expect(await outcome(deviceSocket(`wss://localhost:${m.port}/genie`, { machineRoots: roots }))).toBe('refused');
        expect(m.seen.connections).toBe(0);
    });

    it('a ws:// machine inside the tailnet still connects, as it did', async () => {
        const m = await machine(createHttpServer());
        const socket = deviceSocket(`ws://127.0.0.1:${m.port}/genie`, { machineRoots: roots });
        expect(await outcome(socket)).toBe('open');
        socket.close();
    });

    it('a redirect is not followed: a saved token goes to the address it was minted by and nowhere else', async () => {
        const target = await machine(createHttpServer());
        const server = createHttpServer((_req, res) => { res.writeHead(302, { Location: `ws://127.0.0.1:${target.port}/genie` }); res.end(); });
        open.push(server);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const socket = deviceSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/genie`, { machineRoots: roots });
        expect(await outcome(socket)).toBe('refused');
        expect(target.seen.connections).toBe(0);
    });
});

describe('an error nobody is listening for', () => {
    it('cannot take the host down: giving up on a machine mid-dial closes a socket with no handlers left, and ws would otherwise throw', () => {
        const socket = deviceSocket('ws://127.0.0.1:9/genie', { machineRoots: roots });
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        expect((socket as unknown as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
        socket.close();
    });
});

describe('a frame over the limit', () => {
    async function rigged(frameBytes: number) {
        const server = createHttpServer();
        new WebSocketServer({ server }).on('connection', (socket) => { socket.on('message', () => socket.send('x'.repeat(frameBytes))); });
        open.push(server);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/genie`;
        const events: DeviceLinkEvent[] = [];
        const lines: string[] = [];
        const service = new DeviceLinkService({
            tokens: { tokenFor: async () => ({ kind: 'missing' }), remember: async () => ({ ok: true }), forget: async () => ({ ok: true }), hosts: () => [] },
            socket: (dial) => deviceSocket(dial, { machineRoots: roots, maxPayload: 1024 }),
            send: (_owner, event) => events.push(event),
            log: (line) => lines.push(line),
        });
        const opened = await service.open('w', url);
        if (!opened.ok) throw new Error(opened.reason);
        service.send('w', opened.channel, JSON.stringify({ kind: 'hello', auth: { kind: 'pin', code: '1' } }));
        for (let i = 0; i < 100 && !events.some((e) => e.type === 'closed' || e.type === 'frame'); i += 1) await new Promise((r) => setTimeout(r, 20));
        // A socket still open would hold the server's close: an upgraded socket is not one of its connections any more.
        const heard = [...events];
        service.dropOwner('w');
        return { events: heard, lines };
    }

    it('closes with words that name the limit, in the window and in the log: never a drop with no reason', async () => {
        const { events, lines } = await rigged(2048);
        const closed = events.filter((e) => e.type === 'closed');
        expect(closed).toHaveLength(1);
        const reason = (closed[0] as { reason: string | null }).reason ?? '';
        expect(reason).toContain('100 MiB');
        expect(reason).toMatch(/larger/);
        expect(lines.join('\n')).toContain('100 MiB');
    });

    it('CONTROL: a frame under it arrives', async () => {
        const { events } = await rigged(512);
        expect(events.filter((e) => e.type === 'frame')).toHaveLength(1);
        expect(events.filter((e) => e.type === 'closed')).toEqual([]);
    });

    it('the limit is the one the socket is given, and it is 100 MiB', () => {
        expect(DEVICE_FRAME_LIMIT_BYTES).toBe(100 * 1024 * 1024);
        expect(readFileSync('src/main/device-socket.ts', 'utf8')).toMatch(/maxPayload: options\.maxPayload \?\? DEVICE_FRAME_LIMIT_BYTES/);
    });
});

describe('through the host', () => {
    it('a stranger: open says it could not reach that machine, and no hello goes out', async () => {
        const m = await tlsMachine(STRANGER);
        const url = `wss://localhost:${m.port}/genie`;
        const events: unknown[] = [];
        const service = new DeviceLinkService({
            tokens: { tokenFor: async () => ({ kind: 'value', value: 'dev_token' }), remember: async () => ({ ok: true }), forget: async () => ({ ok: true }), hosts: () => [url] },
            socket: (dial) => deviceSocket(dial, { machineRoots: roots }),
            send: (_owner, event) => events.push(event),
            log: () => {},
        });
        const opened = await service.open('w', url);
        expect(opened.ok).toBe(false);
        expect(opened.ok ? '' : opened.reason).toContain(url);
        expect(m.seen.connections).toBe(0);
        expect(events).toEqual([]);
    });
});

describe('source guards', () => {
    const source = readFileSync('src/main/device-socket.ts', 'utf8');

    it('it asks to verify, explicitly: the environment cannot change an option that is set', () => {
        expect(source).toMatch(/rejectUnauthorized: true/);
    });

    it('by default it uses the host HTTPS set, the one function that reads the bundled roots and the OS store', () => {
        expect(source).toMatch(/import \{[^}]*rootsOfThisMachine[^}]*\} from '\.\/host-https-fetch\.js'/);
        expect(source).toMatch(/options\.machineRoots \?\? rootsOfThisMachine/);
    });

    it('it follows no redirect, by saying so', () => {
        expect(source).toMatch(/followRedirects: false/);
    });

    it('the host dials through it, and has no other WebSocket', () => {
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        expect(host).toMatch(/socket: \(url\) => deviceSocket\(url\)/);
        expect(host).not.toMatch(/new WebSocket\(/);
    });

    it('the package ships it: a dependency, not something a test tool happened to bring', () => {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
        expect(pkg.dependencies.ws).toBeTruthy();
    });
});
