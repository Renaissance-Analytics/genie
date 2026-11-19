import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inMemoryPair, parseMessage, type ClientTransport, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { hostRemoteApi, RemoteAccessHost } from '../src/main/remote-access-host.js';

/*
 * REMOTE ACCESS'S HOST SIDE, IN GENIE-HOST (Tynn #409, host split P5d.1). A phone or a Pilot reaches THIS machine's
 * genie-host, which runs whether a window is open or not: the paired devices, the PIN, the pair prompts, the baton and the
 * lock are its, one of each. What genie-host answers itself is answered with every window closed; what it does not own yet
 * is done by a connected window, and with none it is refused with what to do (later P5d stories move each family here).
 */

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async (auth: unknown, label = 'phone') => { t.send(JSON.stringify({ kind: 'hello', auth, label })); return next(); },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
    };
}

let home = '';
let token = '';
let connections: Array<(c: ServerConnection) => void> = [];
const now = () => 1_000_000;
const connect = () => { const pair = inMemoryPair(); for (const cb of connections) cb(pair.server); return client(pair.client); };

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-remote-access-host-'));
    // A phone paired earlier: its device is in this machine's store.
    const before = await DeviceStore.open(home, { now, random: () => 'tok-phone' });
    token = before.pair('glenn’s phone').token;
    await before.flushed();
    connections = [];
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

/** genie-host's remote API: its own answers (`alone`; absent = still being built) and what it answers ahead of them. */
async function openHost(alone: ((method: string, args: unknown[]) => Promise<unknown>) | null = null) {
    const api = hostRemoteApi({
        hostName: 'alphar',
        // What genie-host owns itself (here: the updater's state, P5b).
        own: { 'updates.state': async () => ({ phase: 'idle', version: '2.0.0-beta.61' }) },
        alone: alone ? { invoke: (method, args) => alone(method, args), onEvent: () => () => {}, workspaceOfAgent: () => null } : null,
    });
    return RemoteAccessHost.open({ home, hostName: 'alphar', api, transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } }, now });
}

describe('remote access, in genie-host', () => {
    it('with EVERY window closed, a paired phone connects and is answered; while genie-host\'s answers are built, it is told to try again', async () => {
        const host = await openHost();
        const phone = connect();
        expect(await phone.hello({ kind: 'token', token })).toMatchObject({ kind: 'welcome', host: 'alphar', isOwner: true });
        expect(await phone.call('updates.state')).toMatchObject({ kind: 'result', ok: true, value: { phase: 'idle', version: '2.0.0-beta.61' } });
        expect(await phone.call('host.home')).toEqual({ kind: 'result', id: 2, ok: false, reason: 'alphar\'s services are still starting; try again in a moment' });
        await host.close();
    });

    it('every other method is genie-host\'s own answers; what it answers ahead of them never reaches them', async () => {
        const asked: Array<{ method: string; args: unknown[] }> = [];
        const host = await openHost(async (method, args) => { asked.push({ method, args }); return method === 'host.home' ? '/home/owner' : { agents: [] }; });
        const phone = connect();
        await phone.hello({ kind: 'token', token });
        expect(await phone.call('snapshot')).toMatchObject({ kind: 'result', ok: true, value: { agents: [] } });
        expect(await phone.call('host.home')).toMatchObject({ kind: 'result', ok: true, value: '/home/owner' });
        await phone.call('updates.state');
        expect(asked).toEqual([{ method: 'snapshot', args: [] }, { method: 'host.home', args: [] }]);
        await host.close();
    });

    it('the paired devices, the PIN and the lock are the host\'s: a revoke is written to this machine\'s store', async () => {
        const host = await openHost();
        const status = host.status();
        expect(status.devices.map((d) => d.label)).toEqual(['glenn’s phone']);
        expect(host.issuePin().code).toMatch(/^\d{6}$/);
        host.lock();
        expect(host.status().locked).toBe(true);
        host.unlock();
        expect(host.revokeDevice(status.devices[0]!.id)).toBe(true);
        await host.close();
        const stored = JSON.parse(await readFile(join(home, 'runtime', 'remote-devices.json'), 'utf8')) as { devices: unknown[] };
        expect(stored.devices).toEqual([]);
        // A revoked phone is refused.
        const again = await openHost();
        expect(await connect().hello({ kind: 'token', token })).toMatchObject({ kind: 'refused' });
        await again.close();
    });
});
