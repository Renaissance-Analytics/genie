import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachWebSocketServer } from '@particle-academy/fancy-ws';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { fancyWsTransport } from '../src/main/ws-server-transport.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { webSocketTransport } from '../src/renderer/ws-transport.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * THE REMOTE PATH OVER A REAL SOCKET (§6.8) — not the in-memory pair: fancy-ws on a real node:http
 * server on loopback, Node's own WebSocket client, the renderer's transport and bridge, the host's
 * RemoteHost. A PIN pairs, a snapshot reads, a write without the baton is refused, the baton is taken,
 * the write lands, an event arrives; a wrong PIN is refused and the client learns it (fancy measured
 * `error` with no `close` on a refused handshake — the transport treats error as close).
 */

const snapshot = { agents: [{ id: 'agent_a', name: 'atlas', workspaceId: 'tynn' }], workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }], deckItems: [], signals: {} };

let dir: string;
let server: ReturnType<typeof createServer>;
let port = 0;
let host: RemoteHost;
let devices: DeviceStore;
const calls: string[] = [];
const listeners = new Set<(channel: string, payload: unknown) => void>();
const api: HostApi = {
    invoke: async (method, args) => { calls.push(`${method}:${JSON.stringify(args)}`); return method === 'snapshot' ? snapshot : { ok: true }; },
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    workspaceOfAgent: () => 'tynn',
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-remote-ws-'));
    calls.length = 0;
    server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => 'tok-real' });
    host = new RemoteHost({ confirm: allowEveryPairing,
        api, hostName: 'alphar', baton: new Baton(),
        pins: new PairingPins({ now: Date.now, random: () => 0.482913 }),
        shares: new ShareLinks({ host: `127.0.0.1:${port}`, now: Date.now, random: () => 's' }),
        devices,
        transport: fancyWsTransport({ attach: attachWebSocketServer, server, path: '/genie', address: () => `ws://127.0.0.1:${port}/genie` }),
    });
});

afterEach(async () => {
    await devices.flushed();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
});

const settle = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));

describe('over fancy-ws', () => {
    it('pairs with the PIN, reads, is refused a write without the baton, takes it, writes, and hears an event', async () => {
        const { code } = host.issuePin();
        const remote = connectRemote(webSocketTransport(`ws://127.0.0.1:${port}/genie`, (url) => new WebSocket(url) as never), { kind: 'pin', code }, 'laptop');
        expect(await remote.ready).toEqual({ ok: true });
        expect(remote.state()).toMatchObject({ connected: true, host: 'alphar', isOwner: true, token: 'tok-real' });
        expect(devices.list().map((d) => d.label)).toEqual(['laptop']);

        expect(await remote.bridge.snapshot()).toEqual(snapshot);
        remote.bridge.openAgent('agent_a');
        await settle();
        expect(remote.state().lastRefusal).toBe('nobody is driving alphar; take the baton to make changes');
        expect(await remote.takeBaton()).toEqual({ ok: true });
        remote.bridge.prompt('agent_a', 'hello over the wire');
        await settle();
        expect(calls).toContain('prompt:["agent_a","hello over the wire"]');

        const got: unknown[] = [];
        remote.bridge.subscribe((s) => got.push(s));
        for (const l of listeners) l('snapshot', snapshot);
        await settle();
        expect(got).toEqual([snapshot]);
        remote.close();
        await settle();
        expect(host.connections()).toEqual([]);
    });

    it('a wrong PIN is refused over the real socket and the client learns it, without waiting forever', async () => {
        host.issuePin();
        const remote = connectRemote(webSocketTransport(`ws://127.0.0.1:${port}/genie`, (url) => new WebSocket(url) as never), { kind: 'pin', code: '000000' }, 'phone');
        const r = await Promise.race([remote.ready, settle(3000).then(() => ({ ok: false, reason: 'TIMED OUT' }))]);
        expect(r).toEqual({ ok: false, reason: 'wrong PIN' });
        expect(remote.state().connected).toBe(false);
        expect(devices.list()).toEqual([]);
    });
});
