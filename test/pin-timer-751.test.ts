import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PIN_TTL_MS, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { RemoteAccessHost } from '../src/main/remote-access-host.js';
import { RemoteAccessReplica } from '../src/main/remote-access-replica.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * THE PIN RUNS OUT OUT LOUD (Tynn #751). At the client call the PIN on the desktop lapsed while the phone was being set
 * up (Tailscale installed and signed in: two to three minutes); the desktop showed nothing new, and the phone was told
 * "no PIN is active". The host now ends the PIN AT its expiry (a timer, not only a lazy read), says why it ended, and
 * tells its listeners, so Settings redraws with "PIN expired" and New PIN. A pairing ends it too: a spent code is not
 * left on screen as if it still worked.
 */

const api: HostApi = {
    invoke: async () => ({ ok: true }),
    onEvent: () => () => {},
    workspaceOfAgent: () => null,
    workspaceOfTerminal: () => null,
};

let dir: string;
let devices: DeviceStore;
let host: RemoteHost;
let now = 1_000_000;
let changes = 0;
let timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
const schedule = (ms: number, fn: () => void) => { const t = { ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
/** Moves the clock and runs every timer due by then, as the real clock would. */
function advance(ms: number) {
    now += ms;
    for (const t of timers.splice(0)) {
        if (t.cancelled) continue;
        if (t.ms <= ms) t.fn(); else timers.push({ ...t, ms: t.ms - ms });
    }
}
let connect: () => { hello: (auth: unknown, label?: string) => Promise<WireMessage> };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-pin-751-'));
    now = 1_000_000;
    changes = 0;
    timers = [];
    devices = await DeviceStore.open(dir, { now: () => now, random: () => 'tok' + (devices?.list().length ?? 0) });
    const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
    host = new RemoteHost({
        api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: () => now, random: () => 0.482913 }), devices,
        confirm: allowEveryPairing, now: () => now, schedule,
        transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } },
    });
    host.onChange(() => { changes += 1; });
    connect = () => {
        const pair = inMemoryPair();
        for (const cb of connections) cb(pair.server);
        const inbox: WireMessage[] = [];
        const waiters: Array<(m: WireMessage) => void> = [];
        pair.client.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
        const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
        return { hello: async (auth: unknown, label = 'phone') => { pair.client.send(JSON.stringify({ kind: 'hello', auth, label })); let m = await next(); while (m.kind === 'pairing') m = await next(); return m; } };
    };
});

afterEach(async () => {
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('the PIN ends at its expiry, and says why', () => {
    it('CONTROL: a fresh PIN is the active one, good for its whole lifetime', () => {
        const pin = host.issuePin();
        expect(host.activePin()).toEqual(pin);
        expect(pin.expiresAt).toBe(now + PIN_TTL_MS);
    });

    it('CONTROL: read after its time, the PIN is gone (the lazy read already did this)', () => {
        host.issuePin();
        now += PIN_TTL_MS + 1;
        expect(host.activePin()).toBeNull();
    });

    it('at its expiry the host ends the PIN on its own: gone, ended as expired, and its listeners told', () => {
        host.issuePin();
        const before = changes;
        advance(PIN_TTL_MS + 1);
        expect(host.activePin()).toBeNull();
        expect(host.pinEnded()).toEqual({ reason: 'expired', at: now });
        expect(changes).toBeGreaterThan(before);
    });

    it('issuing a PIN tells the listeners (Settings shows it at once) and clears an earlier ending', () => {
        host.issuePin();
        advance(PIN_TTL_MS + 1);
        expect(host.pinEnded()?.reason).toBe('expired');
        const before = changes;
        host.issuePin();
        expect(host.pinEnded()).toBeNull();
        expect(changes).toBeGreaterThan(before);
    });

    it('a new PIN replaces the old one’s clock: the old PIN’s expiry does not end the new one, the new one’s does', () => {
        host.issuePin();
        advance(60_000);
        const second = host.issuePin();
        advance(PIN_TTL_MS - 60_000 + 1);
        expect(host.activePin()).toEqual(second);
        expect(host.pinEnded()).toBeNull();
        advance(60_000);
        expect(host.activePin()).toBeNull();
        expect(host.pinEnded()?.reason).toBe('expired');
    });

    it('a Re-pair’s PIN that runs out keeps what it replaces, so its New PIN is a Re-pair too', () => {
        host.issuePin({ replaces: 'dev_old' });
        advance(PIN_TTL_MS + 1);
        expect(host.pinEnded()).toEqual({ reason: 'expired', at: now, replaces: 'dev_old' });
    });

    it('a device that pairs with it spends it: the code is not left on screen, and nothing is said to have gone wrong', async () => {
        const { code } = host.issuePin();
        expect(await connect().hello({ kind: 'pin', code })).toMatchObject({ kind: 'welcome' });
        expect(host.activePin()).toBeNull();
        expect(host.pinEnded()).toBeNull();
    });

    it('five wrong tries cancel it: gone, and ended as cancelled', async () => {
        host.issuePin();
        for (let i = 0; i < 5; i++) await connect().hello({ kind: 'pin', code: '000000' });
        expect(host.activePin()).toBeNull();
        expect(host.pinEnded()).toEqual({ reason: 'cancelled', at: now });
    });
});

describe('the ending reaches Settings', () => {
    it('genie-host’s status carries it, and the window’s replica reads it back', async () => {
        const access = await RemoteAccessHost.open({ api, hostName: 'alphar', home: dir, transport: { onConnection: () => () => {} }, now: () => now, confirm: allowEveryPairing as never });
        access.issuePin();
        now += PIN_TTL_MS + 1;
        const status = access.status();
        expect(status.pin).toBeNull();
        expect(status.pinEnded).toEqual({ reason: 'expired', at: now });
        const replica = new RemoteAccessReplica('alphar', async (method) => (method === 'status' ? status : null));
        await replica.refresh();
        expect(replica.pinEnded()).toEqual({ reason: 'expired', at: now });
        await access.close();
    });
});
