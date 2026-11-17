import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAIR_CONFIRM_MS, PairApprovals, guestAskNotice, guestRefusal, newGuestAsks, type PairRequest } from '../src/core/pair-confirm.js';
import { relayConnectView, withAsking } from '../src/core/relay-connect.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';

/**
 * A SHARE-LINK GUEST GETS IN ONLY WHEN THE PERSON AT THIS MACHINE SAYS SO (Tynn #731; the owner's decision 2026-11-17).
 *
 * On the LiftPoint call a Pilot reached a client's Genie through a share link and was in before the client knew. Now a
 * guest the Tynn relay admits (any non-owner grant) is held at the door: this machine's screen asks "Let <who> in?" with
 * Allow and Deny, and NOTHING of the connection gets through until Allow — no call, no event, no listing. Deny closes it,
 * two minutes with no answer closes it, and the answer is given on this machine only, never by another connection. The
 * owner's own machines, paired devices and a PIN pairing are unchanged (the CONTROLs).
 */

function fakeClock(start = 1_000_000) {
    let t = start;
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    return {
        now: () => t,
        schedule: (ms: number, fn: () => void) => {
            const timer = { at: t + ms, fn, live: true };
            timers.push(timer);
            return () => { timer.live = false; };
        },
        advance(ms: number) {
            t += ms;
            for (const timer of timers) if (timer.live && timer.at <= t) { timer.live = false; timer.fn(); }
        },
    };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeApi(requests: () => readonly PairRequest[]) {
    const invoked: string[] = [];
    const acted: unknown[] = [];
    let emit: ((channel: string, payload: unknown) => void) | null = null;
    const api: HostApi = {
        invoke: async (method, args) => {
            invoked.push(method);
            if (method === 'snapshot') return { agents: [], workspaces: [], deckItems: [], signals: {} };
            if (method === 'features.snapshot') return { remote: { pin: null, devices: [], connections: [], pairRequests: requests() } };
            if (method === 'features.act') { acted.push(args[0]); return { ok: true }; }
            return { ok: true };
        },
        onEvent: (listener) => { emit = listener; return () => { emit = null; }; },
        workspaceOfAgent: () => 'tynn',
        workspaceOfTerminal: () => 'tynn',
        workspacePaths: () => ({ tynn: '/w/Tynn App' }),
    };
    return { api, invoked, acted, emit: (channel: string, payload: unknown) => emit?.(channel, payload) };
}

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    let closed = false;
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    t.onClose(() => { closed = true; });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: (auth: unknown, label = 'wren') => { t.send(JSON.stringify({ kind: 'hello', auth, label })); return next(); },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
        next,
        pending: () => inbox.length,
        closed: () => closed,
        close: () => t.close(),
    };
}

const WORKSPACE_GUEST: PreAuth = { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false };
const READONLY_HOST_GUEST: PreAuth = { label: 'wren', isOwner: false, workspaceId: null, readonly: true };
const OWNER_OVER_RELAY: PreAuth = { label: 'studio', isOwner: true, workspaceId: null, readonly: false };

describe('RemoteHost — a share-link guest waits at the door for Allow (Tynn #731)', () => {
    let dir: string;
    let devices: DeviceStore;
    let host: RemoteHost;
    let approvals: PairApprovals;
    let clock: ReturnType<typeof fakeClock>;
    let api: ReturnType<typeof fakeApi>;
    let pins: PairingPins;
    let connect: (pre?: PreAuth) => ReturnType<typeof client>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-share-approve-'));
        clock = fakeClock();
        let n = 0;
        devices = await DeviceStore.open(dir, { now: clock.now, random: () => `tok${n++}` });
        approvals = new PairApprovals({ host: 'alphar', now: clock.now, schedule: clock.schedule });
        api = fakeApi(() => approvals.requests());
        pins = new PairingPins({ now: clock.now, random: () => 0.482913 });
        const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
        host = new RemoteHost({
            api: api.api, hostName: 'alphar', baton: new Baton(), pins, devices, confirm: approvals,
            transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } },
            now: clock.now, schedule: clock.schedule,
        });
        connect = (pre) => {
            const pair = inMemoryPair();
            const server = { ...pair.server, remoteAddress: pre ? `relay:${pre.label}` : '100.101.7.9', ...(pre ? { preAuth: pre } : {}) };
            for (const cb of connections) cb(server);
            return client(pair.client);
        };
    });

    afterEach(async () => {
        await devices.flushed();
        await rm(dir, { recursive: true, force: true });
    });

    it('a share-link guest is HELD: one "Let wren in?" request naming who and what it reaches; it is told it waits, and is not listed', async () => {
        const guest = connect(WORKSPACE_GUEST);
        expect(await guest.hello({ kind: 'relay' })).toEqual({ kind: 'pairing', host: 'alphar', expiresAt: 1_000_000 + PAIR_CONFIRM_MS, guest: true });
        expect(approvals.requests()).toMatchObject([{ label: 'wren', host: 'alphar', guest: { workspace: 'Tynn App', readonly: false } }]);
        expect(host.connections()).toEqual([]);
        expect(guest.pending()).toBe(0);
    });

    it('while it waits NOTHING gets through: every call is refused, the host API is never called, and no event reaches it', async () => {
        // An owner device is connected, so the host IS listening and broadcasting (the positive control for "no event").
        const { code } = host.issuePin();
        const phone = connect();
        await phone.hello({ kind: 'pin', code }, 'Pixel 7');
        approvals.answer(approvals.requests()[0]!.id, true);
        expect(await phone.next()).toMatchObject({ kind: 'welcome', isOwner: true });

        const guest = connect(WORKSPACE_GUEST);
        expect(await guest.hello({ kind: 'relay' })).toMatchObject({ kind: 'pairing', guest: true });
        api.invoked.length = 0;
        for (const method of ['snapshot', 'features.snapshot', 'agentDetail', 'terminals.write', 'terminals.list', 'host.listDir', 'features.act', 'baton.take']) {
            expect(await guest.call(method, 'tynn')).toEqual({ kind: 'refused', reason: 'say hello first' });
        }
        expect(api.invoked).toEqual([]);
        while (phone.pending() > 0) await phone.next();
        api.emit('features', { remote: {} });
        await settle();
        const heard: WireMessage[] = [];
        while (phone.pending() > 0) heard.push(await phone.next());
        expect(heard.some((m) => m.kind === 'event' && m.channel === 'features')).toBe(true);
        expect(guest.pending()).toBe(0);
        // A second hello cannot jump the queue.
        expect(await guest.hello({ kind: 'relay' })).toMatchObject({ kind: 'refused' });
    });

    it('Allow lets it in, scoped as its grant says, and only then is it listed (the #726 banner)', async () => {
        const guest = connect(WORKSPACE_GUEST);
        await guest.hello({ kind: 'relay' });
        expect(approvals.answer(approvals.requests()[0]!.id, true)).toEqual({ ok: true });
        expect(await guest.next()).toMatchObject({ kind: 'welcome', host: 'alphar', isOwner: false, workspaceId: 'tynn', readonly: false });
        expect(host.connections()).toMatchObject([{ label: 'wren', isOwner: false, workspaceId: 'tynn' }]);
        expect(await guest.call('snapshot')).toMatchObject({ kind: 'result', ok: true });
    });

    it('Deny: the guest is told in words, its connection closes, and it was never listed', async () => {
        const guest = connect(READONLY_HOST_GUEST);
        await guest.hello({ kind: 'relay' });
        expect(approvals.requests()).toMatchObject([{ guest: { workspace: null, readonly: true } }]);
        approvals.answer(approvals.requests()[0]!.id, false);
        expect(await guest.next()).toEqual({ kind: 'refused', reason: 'alphar did not let you in.' });
        await settle();
        expect(guest.closed()).toBe(true);
        expect(host.connections()).toEqual([]);
    });

    it('NO ANSWER in two minutes: refused in words, closed, and the request is gone', async () => {
        const guest = connect(WORKSPACE_GUEST);
        await guest.hello({ kind: 'relay' });
        clock.advance(PAIR_CONFIRM_MS);
        expect(await guest.next()).toEqual({ kind: 'refused', reason: 'Nobody on alphar answered within 2 minutes. Try again.' });
        await settle();
        expect(guest.closed()).toBe(true);
        expect(approvals.requests()).toEqual([]);
    });

    it('the guest hangs up while it waits: its request is withdrawn from this screen', async () => {
        const guest = connect(WORKSPACE_GUEST);
        await guest.hello({ kind: 'relay' });
        expect(approvals.requests()).toHaveLength(1);
        guest.close();
        await settle();
        expect(approvals.requests()).toEqual([]);
        expect(host.connections()).toEqual([]);
    });

    it('the decision cannot come from another connection: a remote features.act answer is refused, and no remote sees the request', async () => {
        const guest = connect(WORKSPACE_GUEST);
        await guest.hello({ kind: 'relay' });
        const id = approvals.requests()[0]!.id;
        const owner = connect(OWNER_OVER_RELAY);
        expect(await owner.hello({ kind: 'relay' }, 'studio')).toMatchObject({ kind: 'welcome', isOwner: true });
        expect(await owner.call('features.act', { kind: 'remote.answerPair', id, allow: true })).toMatchObject({ kind: 'result', ok: false });
        expect(api.acted).toEqual([]);
        expect(approvals.requests().map((r) => r.id)).toEqual([id]);
        expect(await owner.call('features.snapshot')).toMatchObject({ kind: 'result', ok: true, value: { remote: { pairRequests: [] } } });
        expect(guest.pending()).toBe(0);
    });

    it('CONTROL: the owner over the relay (their own machine) comes straight in; nothing is asked', async () => {
        const owner = connect(OWNER_OVER_RELAY);
        expect(await owner.hello({ kind: 'relay' }, 'studio')).toMatchObject({ kind: 'welcome', isOwner: true });
        expect(approvals.requests()).toEqual([]);
    });

    it('CONTROL: a paired device comes straight in with its token; nothing is asked', async () => {
        const { token } = devices.pair('Pixel 7');
        const phone = connect();
        expect(await phone.hello({ kind: 'token', token }, 'Pixel 7')).toMatchObject({ kind: 'welcome', isOwner: true });
        expect(approvals.requests()).toEqual([]);
    });

    it('CONTROL: a PIN still raises a plain "Pair this device?": the same frame, no guest on the request', async () => {
        const { code } = host.issuePin();
        const phone = connect();
        expect(await phone.hello({ kind: 'pin', code }, 'Pixel 7')).toEqual({ kind: 'pairing', host: 'alphar', expiresAt: 1_000_000 + PAIR_CONFIRM_MS });
        expect(approvals.requests()[0]!.guest).toBeUndefined();
    });
});

describe('the words and the wiring (Tynn #731)', () => {
    const guestRequest = (over: Partial<PairRequest> = {}): PairRequest => ({ id: 'pair_1', label: 'wren', from: 'relay:wren', host: 'alphar', replaces: null, raisedAt: 0, expiresAt: PAIR_CONFIRM_MS, guest: { workspace: 'Tynn App', readonly: false }, ...over });

    it('the guest is told why it is not in: denied, or nobody answered', () => {
        expect(guestRefusal('deny', 'alphar')).toBe('alphar did not let you in.');
        expect(guestRefusal('timeout', 'alphar')).toBe('Nobody on alphar answered within 2 minutes. Try again.');
    });

    it('a desktop notification asks for the answer, so a hidden window cannot let the request lapse unseen', () => {
        expect(guestAskNotice(guestRequest())).toEqual({ title: 'wren wants to connect to alphar', body: 'Allow or Deny in Genie within 2 minutes.' });
    });

    it('each guest request is notified once; a PIN pairing never is; what was answered is forgotten', () => {
        const seen = new Set<string>();
        const { guest: _guest, ...pin } = guestRequest({ id: 'pair_pin' });
        expect(newGuestAsks(seen, [pin, guestRequest()]).map((r) => r.id)).toEqual(['pair_1']);
        expect(newGuestAsks(seen, [pin, guestRequest()])).toEqual([]);
        expect(newGuestAsks(seen, [])).toEqual([]);
        expect(seen.size).toBe(0);
        expect(newGuestAsks(seen, [guestRequest()]).map((r) => r.id)).toEqual(['pair_1']);
    });

    it('the wire keeps a guest wait as a guest wait', () => {
        expect(parseMessage(JSON.stringify({ kind: 'pairing', host: 'alphar', expiresAt: 5, guest: true }))).toEqual({ ok: true, message: { kind: 'pairing', host: 'alphar', expiresAt: 5, guest: true } });
    });

    it('CONTROL: a PIN wait parses to exactly what it always did', () => {
        expect(parseMessage(JSON.stringify({ kind: 'pairing', host: 'alphar', expiresAt: 5 }))).toEqual({ ok: true, message: { kind: 'pairing', host: 'alphar', expiresAt: 5 } });
    });

    it('the remote window learns it is waiting to be let in', async () => {
        const pair = inMemoryPair();
        const remote = connectRemote(pair.client, { kind: 'relay' }, 'wren');
        pair.server.send(JSON.stringify({ kind: 'pairing', host: 'alphar', expiresAt: 5, guest: true }));
        await settle();
        expect(remote.state().pairing).toEqual({ expiresAt: 5, guest: true });
        remote.close();
    });

    it('its connect screen says so: waiting for the machine to let you in', () => {
        const asking = withAsking({ kind: 'working', step: 'host' }, { expiresAt: 5, guest: true } as { guest: true });
        expect(asking).toEqual({ kind: 'working', step: 'host', asking: true });
        expect(relayConnectView('aion', asking).notice).toBe('Waiting for aion to let you in…');
    });

    it('CONTROL: no guest wait, no notice; an earlier step is not marked asking', () => {
        expect(withAsking({ kind: 'working', step: 'host' }, null)).toEqual({ kind: 'working', step: 'host' });
        expect(withAsking({ kind: 'working', step: 'tynn' }, { guest: true })).toEqual({ kind: 'working', step: 'tynn' });
        expect(relayConnectView('aion', { kind: 'working', step: 'host' }).notice).toBeNull();
    });

    it('wiring: main notifies each new guest request, and the remote window shows the wait', () => {
        const main = readFileSync(join(__dirname, '../src/main/main.ts'), 'utf8');
        const block = main.slice(main.indexOf('composed.pairing.onChange('), main.indexOf('const arrivals = new ConnectWatch()'));
        expect(block).toContain('newGuestAsks(');
        expect(block).toContain('guestAskNotice(');
        const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
        expect(app).toMatch(/withAsking\(\s*relayConnect,\s*state\?\.pairing/);
    });
});
