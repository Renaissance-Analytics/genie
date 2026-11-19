import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectedHere, connectedWords, type HereConnection } from '../src/core/connected-here.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { BATON_EVENT, inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { handleFeatureAction, featureSnapshot, type FeatureState } from '../src/main/feature-ipc.js';
import type { ComposedServices } from '../src/main/compose.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { composeServices } from './helpers/compose-alone.js';
import { CALLER_A, presentationFixture, type PresentationFixture } from './helpers/features-host-presentation.js';

/**
 * TWO DRIVE MODES, PICKED BY THE PERSON AT THE MACHINE (Tynn #732; the owner's decision 2026-11-17): view only, or full
 * control, per connected person, switchable at any time, shown in the #726 banner and on the other window's badge. View
 * only is ENFORCED HERE, at the host: that person holds no baton (taken back at the switch, which also ends their Take Over
 * windows), every change they send is refused in words, and their window is told. The mode belongs to the person and
 * survives their leaving and coming back. Only this machine's own window sets it.
 */

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeApi() {
    const invoked: string[] = [];
    const acted: unknown[] = [];
    const api: HostApi = {
        invoke: async (method, args) => {
            invoked.push(method);
            if (method === 'snapshot') return { agents: [], workspaces: [], deckItems: [], signals: {} };
            if (method === 'features.act') { acted.push(args[0]); return { ok: true }; }
            return { ok: true };
        },
        onEvent: () => () => {},
        workspaceOfAgent: () => 'tynn',
        workspaceOfTerminal: () => 'tynn',
        workspacePaths: () => ({ tynn: '/w/tynn' }),
    };
    return { api, invoked, acted };
}

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async (label: string) => { t.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label })); let m = await next(); while (m.kind === 'pairing') m = await next(); return m; },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); let m = await next(); while (m.kind === 'event') m = await next(); return m; },
        next,
        drain: () => inbox.splice(0),
        close: () => t.close(),
    };
}

const WREN: PreAuth = { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false };
const PAT: PreAuth = { label: 'Pat', isOwner: false, workspaceId: 'tynn', readonly: false };
const OWNER: PreAuth = { label: 'studio', isOwner: true, workspaceId: null, readonly: false };
const VIEW_ONLY = 'alphar set wren to view only';

describe('RemoteHost — view only is enforced at the host (Tynn #732)', () => {
    let dir: string;
    let devices: DeviceStore;
    let host: RemoteHost;
    let api: ReturnType<typeof fakeApi>;
    let connect: (pre: PreAuth) => ReturnType<typeof client>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-drive-modes-'));
        let n = 0;
        devices = await DeviceStore.open(dir, { now: () => 1_000_000, random: () => `tok${n++}` });
        api = fakeApi();
        const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
        host = new RemoteHost({
            api: api.api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: () => 1_000_000 }), devices, confirm: allowEveryPairing,
            transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } }, now: () => 1_000_000,
        });
        connect = (pre) => {
            const pair = inMemoryPair();
            for (const cb of connections) cb({ ...pair.server, remoteAddress: `relay:${pre.label}`, preAuth: pre });
            return client(pair.client);
        };
    });

    afterEach(async () => {
        await devices.flushed();
        await rm(dir, { recursive: true, force: true });
    });

    async function driving(pre: PreAuth) {
        const c = connect(pre);
        expect(await c.hello(pre.label)).toMatchObject({ kind: 'welcome' });
        expect(await c.call('baton.watch')).toMatchObject({ ok: true });
        expect(await c.call('baton.take')).toMatchObject({ ok: true });
        return c;
    }

    it('CONTROL: a person starts in full control: listed as such, and may drive and change things', async () => {
        const wren = await driving(WREN);
        expect(host.connections()).toMatchObject([{ label: 'wren', mode: 'control', driving: true }]);
        expect(await wren.call('prompt', 'agent_a', 'hi')).toMatchObject({ kind: 'result', ok: true });
    });

    it('view only: every change that person sends is refused in words, and never reaches the host API; reads still answer', async () => {
        const wren = await driving(WREN);
        host.setMode('wren', 'view');
        await settle();
        api.invoked.length = 0;
        for (const [method, args] of [['prompt', ['agent_a', 'hi']], ['openAgent', ['agent_a']], ['terminals.write', ['term_1', 'ls\r']]] as const) {
            expect(await wren.call(method, ...args)).toEqual({ kind: 'result', id: expect.any(Number), ok: false, reason: VIEW_ONLY });
        }
        expect(api.invoked).toEqual([]);
        expect(await wren.call('snapshot')).toMatchObject({ kind: 'result', ok: true });
    });

    it('the switch to view only takes their baton back at once and tells their window; they are listed as view only', async () => {
        const wren = await driving(WREN);
        wren.drain();
        host.setMode('wren', 'view');
        await settle();
        expect(wren.drain()).toContainEqual({ kind: 'event', channel: BATON_EVENT, payload: { driver: null, mine: false, locked: false, by: null, viewOnly: true } });
        expect(host.connections()).toMatchObject([{ label: 'wren', mode: 'view', driving: false }]);
    });

    it('view only: no baton, and no file staging', async () => {
        const wren = await driving(WREN);
        host.setMode('wren', 'view');
        await settle();
        expect(await wren.call('baton.take', { force: true })).toMatchObject({ ok: false, reason: VIEW_ONLY });
        expect(await wren.call('upload.begin', { name: 'a.txt', size: 3 })).toMatchObject({ ok: false, reason: VIEW_ONLY });
    });

    it('back to full control: their window is told, and they may drive and change things again', async () => {
        const wren = await driving(WREN);
        host.setMode('wren', 'view');
        await settle();
        wren.drain();
        host.setMode('wren', 'control');
        await settle();
        expect(wren.drain()).toContainEqual({ kind: 'event', channel: BATON_EVENT, payload: { driver: null, mine: false, locked: false, by: null } });
        expect(await wren.call('baton.take')).toMatchObject({ ok: true });
        expect(await wren.call('prompt', 'agent_a', 'hi')).toMatchObject({ ok: true });
    });

    it('the mode is the person\'s: it stays when they leave and come back, and the welcome says so', async () => {
        const wren = await driving(WREN);
        host.setMode('wren', 'view');
        wren.close();
        await settle();
        const again = connect(WREN);
        expect(await again.hello('wren')).toMatchObject({ kind: 'welcome', viewOnly: true });
        expect(await again.call('prompt', 'agent_a', 'hi')).toMatchObject({ ok: false, reason: VIEW_ONLY });
    });

    it('only this machine\'s own window sets a mode: features.act remote.setMode from another connection is refused, even the owner\'s', async () => {
        const owner = await driving(OWNER);
        expect(await owner.call('features.act', { kind: 'remote.setMode', label: 'Pat', mode: 'control' })).toMatchObject({ kind: 'result', ok: false });
        expect(api.acted).toEqual([]);
    });

    it('CONTROL: one person set to view only leaves another in full control', async () => {
        const wren = await driving(WREN);
        expect(await wren.call('baton.release')).toMatchObject({ ok: true });
        host.setMode('wren', 'view');
        const pat = await driving(PAT);
        expect(await pat.call('prompt', 'agent_a', 'hi')).toMatchObject({ ok: true });
    });

    it('CONTROL: a read-only grant is refused in its own words', async () => {
        const ro = connect({ ...WREN, readonly: true });
        await ro.hello('wren');
        expect(await ro.call('prompt', 'agent_a', 'hi')).toMatchObject({ ok: false, reason: 'wren has read-only access to alphar' });
    });
});

describe('from this machine\'s window to the host, composed (Tynn #732)', () => {
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
    let dir: string;
    let services: ComposedServices;
    let accept: (c: ServerConnection) => void = () => {};

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-drive-modes-compose-'));
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, remoteHost: { hostName: 'alphar', transport: { onConnection: (cb) => { accept = cb; return () => {}; } } } });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
    });

    it('the banner\'s switch (remote.setMode) sets the person to view only; the features snapshot lists the mode', async () => {
        const pair = inMemoryPair();
        accept({ ...pair.server, remoteAddress: 'relay:wren', preAuth: WREN });
        const guest = client(pair.client);
        const welcomed = guest.hello('wren');
        // #731: the guest is let in on this screen first.
        await settle();
        await handleFeatureAction(services, { kind: 'remote.answerPair', id: services.pairing.requests()[0]!.id, allow: true }, state());
        expect(await welcomed).toMatchObject({ kind: 'welcome' });
        const set = await handleFeatureAction(services, { kind: 'remote.setMode', label: 'wren', mode: 'view' }, state());
        expect(set.remote!.connections).toMatchObject([{ label: 'wren', mode: 'view' }]);
        expect((await featureSnapshot(services, state())).remote!.connections).toMatchObject([{ label: 'wren', mode: 'view' }]);
    });
});

describe('features-host: a mode is set from this machine\'s own window only (Tynn #732)', () => {
    let f: PresentationFixture;
    beforeEach(async () => { f = await presentationFixture(); });
    afterEach(async () => { await f?.close(); });

    it('a call from another connection is refused, in words', async () => {
        expect(await f.invoke({ kind: 'remote.setMode', label: 'wren', mode: 'control' }, { ...CALLER_A, origin: 'relay' }))
            .toMatchObject({ ok: false, reason: expect.stringContaining('own screen') });
    });
});

describe('the banner\'s words (Tynn #732)', () => {
    const conn = (id: string, label: string, mode: 'view' | 'control', driving = false): HereConnection => ({ id, label, driving, mode });

    it('one person on view only: "wren is connected · view only"', () => {
        const here = connectedHere([conn('c1', 'wren', 'view')])!;
        expect(here.viewOnly).toEqual(['wren']);
        expect(connectedWords(here)).toBe('wren is connected · view only');
    });

    it('two people, one on view only: both named, and who only views', () => {
        expect(connectedWords(connectedHere([conn('c1', 'wren', 'view'), conn('c2', 'Pat', 'control', true)])!)).toBe('wren and Pat are connected · Pat driving · wren view only');
    });

    it('CONTROL: full control reads as before', () => {
        expect(connectedWords(connectedHere([conn('c1', 'wren', 'control', true)])!)).toBe('wren is connected · driving');
    });
});
