import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PASSKEY_LOCK_EVENT, PASSKEY_LOCK_METHODS, LOCKED_ALLOWED } from '../src/core/passkey-lock.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { CONTROL_METHODS, REMOTE_METHODS, inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { PasskeyLock, windowLockClient } from '../src/main/passkey-lock.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { SoftAuthenticator } from './support/soft-authenticator.js';

/**
 * A LOCKED CLIENT GETS NOTHING (Tynn #677, S1). The connection layer genie-host serves its clients through (RemoteHost)
 * asks the passkey lock about every connection: a locked one may call the lock's own four methods and nothing else — every
 * other call is refused, typed `code: 'locked'`, before the host API is asked anything — and no live push reaches it but
 * the lock's own. An unlocked connection, and every connection while the lock is off, is served as before.
 */

const ORIGIN = 'http://genie.localhost:24567';
let dir: string;
let lock: PasskeyLock;
let devices: DeviceStore;
let host: RemoteHost;
let calls: string[];
let emit: (channel: string, payload: unknown) => void;
let connect: () => ReturnType<typeof client>;
let connectionsCb: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void>;
let auth: SoftAuthenticator;

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async () => { t.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label: 'owner' })); return next(); },
        /** The call's own result; an event that arrives first is returned instead, which is how a test sees a push. */
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
        next,
    };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-lock-host-'));
    lock = await PasskeyLock.open({ file: join(dir, 'runtime', 'passkey-lock.json') });
    devices = await DeviceStore.open(dir, { random: () => 'tok' });
    calls = [];
    const listeners = new Set<(channel: string, payload: unknown) => void>();
    emit = (channel, payload) => { for (const l of listeners) l(channel, payload); };
    const api: HostApi = {
        invoke: async (method) => { calls.push(method); return method === 'snapshot' ? { agents: [], workspaces: [] } : { ok: true }; },
        onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        workspaceOfAgent: () => null,
    };
    const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
    connectionsCb = connections;
    host = new RemoteHost({
        api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins(), devices, confirm: allowEveryPairing,
        transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } },
        // Every connection here is the owner's window on genie.localhost (what genie-host gives a local window).
        passkeyLock: { gate: lock, client: () => windowLockClient(() => ORIGIN, 'owner') },
    });
    const owner: PreAuth = { label: 'owner', isOwner: true, workspaceId: null, readonly: false };
    connect = () => { const pair = inMemoryPair(); for (const cb of connections) cb({ ...pair.server, remoteAddress: 'relay:owner', preAuth: owner }); return client(pair.client); };
    auth = new SoftAuthenticator();
});
afterEach(async () => {
    await lock.flushed();
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

/** Turn the lock on by enrolling from a client of its own, as the owner's first device would. */
async function turnOn(): Promise<void> {
    lock.attach('enroller', windowLockClient(() => ORIGIN, 'enroller'));
    const begun = await lock.call('enroller', 'passkeyLock.beginEnroll', ['Windows Hello']) as { state: string; publicKey: { challenge: string; rp: { id?: string }; user: { id: string } } };
    await lock.call('enroller', 'passkeyLock.finishEnroll', [begun.state, auth.create(begun.publicKey, { origin: ORIGIN }), 'Windows Hello']);
}

/** Every method a client could name, but the lock's own. */
const EVERY_OTHER = [...REMOTE_METHODS, ...CONTROL_METHODS].filter((m) => !(PASSKEY_LOCK_METHODS as readonly string[]).includes(m));

describe('with the lock off (the default), nothing changes', () => {
    it('a connection is served and hears pushes (the positive control)', async () => {
        const c = connect();
        expect(await c.hello()).toMatchObject({ kind: 'welcome' });
        expect(await c.call('snapshot')).toMatchObject({ kind: 'result', ok: true });
        emit('snapshot', { n: 1 });
        expect(await c.next()).toMatchObject({ kind: 'event', channel: 'snapshot' });
        expect(calls).toContain('snapshot');
    });
});

describe('a locked connection', () => {
    it('is told it is locked, and may ask for its status', async () => {
        await turnOn();
        const c = connect();
        expect(await c.hello()).toMatchObject({ kind: 'welcome' });
        expect(await c.call('passkeyLock.status')).toMatchObject({ kind: 'result', ok: true, value: { enabled: true, locked: true, devices: 1, canUnlock: true } });
    });

    it.each(EVERY_OTHER)('%s is refused, typed locked, and the host API is never asked', async (method) => {
        await turnOn();
        const c = connect();
        await c.hello();
        const r = await c.call(method, 'agent_a', 'x');
        expect(r).toMatchObject({ kind: 'result', ok: false, code: 'locked' });
        expect(calls).toEqual([]);
    });

    it('hears no push but the lock’s own', async () => {
        await turnOn();
        const c = connect();
        await c.hello();
        for (const channel of ['snapshot', 'agent:agent_a', 'features', 'updates', 'terminal-data', 'terminal-exit']) emit(channel, { n: 1 });
        // Had any push been sent it would arrive before this call's result.
        expect(await c.call('passkeyLock.status')).toMatchObject({ kind: 'result', ok: true });
    });

    it('unlocked with a passkey over the wire, it is served and hears pushes; locked again, it is refused again', async () => {
        await turnOn();
        const c = connect();
        await c.hello();
        const begun = await c.call('passkeyLock.beginUnlock') as Extract<WireMessage, { kind: 'result'; ok: true }>;
        const { state, publicKey } = begun.value as { state: string; publicKey: { challenge: string; rpId?: string } };
        expect(await c.call('passkeyLock.finishUnlock', state, auth.get(publicKey, { origin: ORIGIN }))).toMatchObject({ kind: 'event', channel: PASSKEY_LOCK_EVENT, payload: { locked: false } });
        expect(await c.next()).toMatchObject({ kind: 'result', ok: true, value: { locked: false } });
        expect(await c.call('snapshot')).toMatchObject({ kind: 'result', ok: true });
        emit('snapshot', { n: 2 });
        expect(await c.next()).toMatchObject({ kind: 'event', channel: 'snapshot' });
        expect(await c.call('passkeyLock.lockNow')).toMatchObject({ kind: 'event', channel: PASSKEY_LOCK_EVENT, payload: { locked: true } });
        await c.next();
        expect(await c.call('snapshot')).toMatchObject({ kind: 'result', ok: false, code: 'locked' });
    });

    it('a wrong passkey answer leaves it locked', async () => {
        await turnOn();
        const c = connect();
        await c.hello();
        const begun = await c.call('passkeyLock.beginUnlock') as Extract<WireMessage, { kind: 'result'; ok: true }>;
        const { state, publicKey } = begun.value as { state: string; publicKey: { challenge: string; rpId?: string } };
        expect(await c.call('passkeyLock.finishUnlock', state, auth.get(publicKey, { origin: 'http://genie.localhost:1' }))).toMatchObject({ kind: 'result', ok: false });
        expect(await c.call('snapshot')).toMatchObject({ kind: 'result', ok: false, code: 'locked' });
    });

    it('turning the lock on locks connections already open, and they are told', async () => {
        const c = connect();
        await c.hello();
        expect(await c.call('snapshot')).toMatchObject({ kind: 'result', ok: true });
        await turnOn();
        expect(await c.next()).toMatchObject({ kind: 'event', channel: PASSKEY_LOCK_EVENT, payload: { locked: true } });
        expect(await c.call('snapshot')).toMatchObject({ kind: 'result', ok: false, code: 'locked' });
    });
});

describe('managing the lock is the owner’s', () => {
    const guestOf = (who: PreAuth) => { const pair = inMemoryPair(); for (const cb of connectionsCb) cb({ ...pair.server, remoteAddress: 'relay:wren', preAuth: who }); return client(pair.client); };
    it.each([
        ['a workspace guest', { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false }],
        ['a read-only link', { label: 'wren', isOwner: true, workspaceId: null, readonly: true }],
    ] as const)('%s cannot turn the lock on, enroll, list or remove devices, or turn it off; the owner can (control)', async (_name, who) => {
        const g = guestOf(who);
        await g.hello();
        for (const method of ['passkeyLock.beginEnroll', 'passkeyLock.finishEnroll', 'passkeyLock.disable', 'passkeyLock.devices', 'passkeyLock.removeDevice'])
            expect(await g.call(method, 'x', {}, 'x'), method).toMatchObject({ kind: 'result', ok: false });
        expect(lock.enabled).toBe(false);
        const owner = connect();
        await owner.hello();
        expect(await owner.call('passkeyLock.beginEnroll', 'Windows Hello')).toMatchObject({ kind: 'result', ok: true });
    });
});

it('the allowlist a locked connection may call is exactly the lock’s four', () => {
    expect([...LOCKED_ALLOWED].sort()).toEqual(['passkeyLock.beginUnlock', 'passkeyLock.finishUnlock', 'passkeyLock.lockNow', 'passkeyLock.status']);
});
