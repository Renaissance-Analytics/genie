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
/** Runs inside the host's handling of a call, as an action's sign-in does: given the connection's id. */
let duringCall: ((connectionId: string) => unknown) | null = null;
let connectRelay: (who: PreAuth) => ReturnType<typeof client>;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-remote-host-731-'));
    devices = await DeviceStore.open(dir, { now: () => 1, random: () => 'tok' });
    const accepts: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
    duringCall = null;
    const api: HostApi = { invoke: async (method, _args, context) => { if (method === 'snapshot' && duringCall) await duringCall(context!.connectionId); return { ok: true }; }, onEvent: () => () => {}, workspaceOfAgent: () => null };
    host = new RemoteHost({ confirm: allowEveryPairing, api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: () => 1, random: () => 0.482913 }), devices,
        transport: { onConnection: cb => { accepts.push(cb); return () => {}; } } });
    connectRelay = who => { const pair = inMemoryPair(); for (const cb of accepts) cb({ ...pair.server, remoteAddress: 'relay:x', preAuth: who }); return client(pair.client); };
});
afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

const owner: PreAuth = { label: 'laptop', isOwner: true, workspaceId: null, readonly: false };
type Pilot = { openOnPilot(connectionId: string, url: string): Promise<void> };
const pilotPort = () => host as unknown as Pilot;

describe('the host opens a sign-in link on one Pilot connection, only for the action that asked (Tynn #731)', () => {
    it('an action in progress on a connection sends its link to THAT connection, naming the request; another connection receives nothing', async () => {
        const a = connectRelay(owner), b = connectRelay(owner);
        const welcomeA = await a.hello({ kind: 'relay' }), welcomeB = await b.hello({ kind: 'relay' });
        expect(welcomeA.connectionId).not.toBe(welcomeB.connectionId);
        duringCall = id => pilotPort().openOnPilot(id, 'https://github.com/login/device');
        await a.call('snapshot'); await b.call('updates.state');
        expect(a.events()).toEqual([{ kind: 'event', channel: SIGN_IN_CHANNEL, payload: { url: 'https://github.com/login/device', request: 1 } }]);
        expect(b.events()).toEqual([]);
    });
    it('the request id is the id of the call that is in progress, not a later or earlier one', async () => {
        const a = connectRelay(owner);
        const welcome = await a.hello({ kind: 'relay' });
        await a.call('updates.state');
        duringCall = id => pilotPort().openOnPilot(id, 'https://github.com/login/device');
        await a.call('snapshot');
        expect(a.events().map(e => (e as { payload: { request: number } }).payload.request)).toEqual([2]);
        expect(welcome.connectionId).toBeTruthy();
    });
    it('a link with no action in progress is refused: the host cannot push a page at a Pilot unprompted', async () => {
        const a = connectRelay(owner);
        const welcome = await a.hello({ kind: 'relay' });
        await expect(pilotPort().openOnPilot(welcome.connectionId, 'https://github.com/login/device')).rejects.toThrow(/in answer to a sign-in/i);
        await a.call('updates.state');
        expect(a.events()).toEqual([]);
    });
    it('an action running on ANOTHER connection cannot send a link to this one', async () => {
        const a = connectRelay(owner), b = connectRelay(owner);
        const welcomeA = await a.hello({ kind: 'relay' }); await b.hello({ kind: 'relay' });
        let refusal = '';
        duringCall = async () => { try { await pilotPort().openOnPilot(welcomeA.connectionId, 'https://github.com/login/device'); } catch (e) { refusal = String(e); } };
        await b.call('snapshot');
        expect(refusal).toMatch(/in answer to a sign-in/i);
        expect(a.events()).toEqual([]);
    });
    it('a guest of one workspace is refused in words and receives nothing', async () => {
        const g = connectRelay({ label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false });
        await g.hello({ kind: 'relay' }, 'wren');
        let refusal = '';
        duringCall = async id => { try { await pilotPort().openOnPilot(id, 'https://github.com/login/device'); } catch (e) { refusal = String(e); } };
        await g.call('snapshot');
        expect(refusal).toMatch(/guest of one workspace.*cannot sign in/i);
        expect(g.events()).toEqual([]);
    });
    it('a read-only connection is refused in words and receives nothing', async () => {
        const r = connectRelay({ ...owner, readonly: true });
        await r.hello({ kind: 'relay' });
        let refusal = '';
        duringCall = async id => { try { await pilotPort().openOnPilot(id, 'https://github.com/login/device'); } catch (e) { refusal = String(e); } };
        await r.call('snapshot');
        expect(refusal).toMatch(/read-only.*cannot sign in/i);
        expect(r.events()).toEqual([]);
    });
    it('a connection that is gone is refused in words', async () => {
        await expect(pilotPort().openOnPilot('no-such-connection', 'https://github.com/login/device')).rejects.toThrow(/no longer connected/i);
    });
    it('the host sends only https links; a file or http link is refused and nothing is sent', async () => {
        const a = connectRelay(owner);
        await a.hello({ kind: 'relay' });
        const refusals: string[] = [];
        duringCall = async id => { for (const url of ['file:///etc/passwd', 'http://github.com/login', 'javascript:alert(1)', 'not a url']) { try { await pilotPort().openOnPilot(id, url); } catch (e) { refusals.push(String(e)); } } };
        await a.call('snapshot');
        expect(refusals).toHaveLength(4);
        expect(refusals.every(r => /https/i.test(r))).toBe(true);
        expect(a.events()).toEqual([]);
    });
});
