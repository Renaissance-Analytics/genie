import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

// Tynn #731: the host sends a sign-in link over ONE admitted connection, the Pilot's, and to no other.
const SIGN_IN_CHANNEL = 'sign-in.open';

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    t.onMessage(text => { const r = parseMessage(text); if (r.ok) inbox.push(r.message); });
    const tick = () => new Promise<void>(r => setTimeout(r, 0));
    let id = 0;
    return {
        inbox,
        hello: async (auth: unknown, label = 'laptop') => { t.send(JSON.stringify({ kind: 'hello', auth, label })); await tick(); return inbox.find(m => m.kind === 'welcome') as Extract<WireMessage, { kind: 'welcome' }>; },
        call: async (method: string) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args: [] })); await tick(); },
        events: () => inbox.filter(m => m.kind === 'event' && m.channel === SIGN_IN_CHANNEL),
    };
}

let dir: string, host: RemoteHost, devices: DeviceStore;
let connectRelay: (who: PreAuth) => ReturnType<typeof client>;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-remote-host-731-'));
    devices = await DeviceStore.open(dir, { now: () => 1, random: () => 'tok' });
    const accepts: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
    const api: HostApi = { invoke: async () => ({ ok: true }), onEvent: () => () => {}, workspaceOfAgent: () => null };
    host = new RemoteHost({ confirm: allowEveryPairing, api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: () => 1, random: () => 0.482913 }), devices,
        transport: { onConnection: cb => { accepts.push(cb); return () => {}; } } });
    connectRelay = who => { const pair = inMemoryPair(); for (const cb of accepts) cb({ ...pair.server, remoteAddress: 'relay:x', preAuth: who }); return client(pair.client); };
});
afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

const owner: PreAuth = { label: 'laptop', isOwner: true, workspaceId: null, readonly: false };
type Pilot = { openOnPilot(connectionId: string, url: string): Promise<void> };
const pilotPort = () => host as unknown as Pilot;

describe('the host opens a sign-in link on one Pilot connection (Tynn #731)', () => {
    it('the owner’s connection receives the URL as an event; another connection receives nothing', async () => {
        const a = connectRelay(owner), b = connectRelay(owner);
        const welcomeA = await a.hello({ kind: 'relay' }), welcomeB = await b.hello({ kind: 'relay' });
        expect(welcomeA.connectionId).not.toBe(welcomeB.connectionId);
        await pilotPort().openOnPilot(welcomeA.connectionId, 'https://github.com/login/device');
        await a.call('snapshot'); await b.call('snapshot');
        expect(a.events()).toEqual([{ kind: 'event', channel: SIGN_IN_CHANNEL, payload: { url: 'https://github.com/login/device' } }]);
        expect(b.events()).toEqual([]);
    });
    it('a guest of one workspace is refused in words and receives nothing', async () => {
        const g = connectRelay({ label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false });
        const welcome = await g.hello({ kind: 'relay' }, 'wren');
        await expect(pilotPort().openOnPilot(welcome.connectionId, 'https://github.com/login/device')).rejects.toThrow(/guest of one workspace.*cannot sign in/i);
        await g.call('snapshot');
        expect(g.events()).toEqual([]);
    });
    it('a read-only connection is refused in words and receives nothing', async () => {
        const r = connectRelay({ ...owner, readonly: true });
        const welcome = await r.hello({ kind: 'relay' });
        await expect(pilotPort().openOnPilot(welcome.connectionId, 'https://github.com/login/device')).rejects.toThrow(/read-only.*cannot sign in/i);
        expect(r.events()).toEqual([]);
    });
    it('a connection that is gone is refused in words', async () => {
        await expect(pilotPort().openOnPilot('no-such-connection', 'https://github.com/login/device')).rejects.toThrow(/no longer connected/i);
    });
    it('the host sends only https links; a file or http link is refused and nothing is sent', async () => {
        const a = connectRelay(owner);
        const welcome = await a.hello({ kind: 'relay' });
        for (const url of ['file:///etc/passwd', 'http://github.com/login', 'javascript:alert(1)', 'not a url']) {
            await expect(pilotPort().openOnPilot(welcome.connectionId, url)).rejects.toThrow(/https/i);
        }
        await a.call('snapshot');
        expect(a.events()).toEqual([]);
    });
});
