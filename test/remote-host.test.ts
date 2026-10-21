import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';

/**
 * THE REMOTE HOST (§6.8) — another machine (or a phone) drives THIS Genie over a transport. The host
 * authenticates a connection (a PIN read off this screen pairs a device of the OWNER's and mints a
 * durable token; a share link admits a GUEST to one workspace), then gates every call by the one
 * table: a read is never gated, a write needs the baton, an upgrade needs ownership, host-only
 * methods are refused with where to do them. Events reach every connection, a guest's filtered to
 * its workspace. The transport is a port; here it is an in-memory pair, later fancy-ws.
 */

const snapshot = {
    agents: [
        { id: 'agent_a', name: 'atlas', workspaceId: 'tynn' },
        { id: 'agent_b', name: 'bolt', workspaceId: 'fancy' },
    ],
    workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', path: '/w/fancy', agentsKnown: true }],
    deckItems: [{ id: 'q_1', workspaceId: 'tynn' }, { id: 'q_2', workspaceId: 'fancy' }],
    signals: {},
};

function fakeApi() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const listeners = new Set<(channel: string, payload: unknown) => void>();
    const api: HostApi = {
        invoke: async (method, args) => {
            calls.push({ method, args });
            if (method === 'snapshot') return snapshot;
            if (method === 'openAgent') return { ok: true };
            if (method === 'updates.install') return { report: 'stopped 2 processes' };
            return { ok: true };
        },
        onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        workspaceOfAgent: (id) => snapshot.agents.find((a) => a.id === id)?.workspaceId ?? null,
        workspaceOfTerminal: (id) => ({ term_t: 'tynn', term_f: 'fancy' } as Record<string, string>)[id] ?? null,
    };
    return { api, calls, emit: (channel: string, payload: unknown) => { for (const l of listeners) l(channel, payload); } };
}

/** A client end: send a frame, await the next frame(s). */
function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async (auth: unknown, label = 'phone') => { t.send(JSON.stringify({ kind: 'hello', auth, label })); return next(); },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
        next,
        close: () => t.close(),
    };
}

let dir: string;
let host: RemoteHost;
let api: ReturnType<typeof fakeApi>;
let pins: PairingPins;
let shares: ShareLinks;
let devices: DeviceStore;
let now = 1_000_000;
let connect: () => ReturnType<typeof client>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-remote-host-'));
    api = fakeApi();
    pins = new PairingPins({ now: () => now, random: () => 0.482913 });
    shares = new ShareLinks({ host: 'alphar.tailnet.invalid:7421', now: () => now, random: () => 'sekrit' });
    devices = await DeviceStore.open(dir, { now: () => now, random: () => 'tok' + (devices?.list().length ?? 0) });
    const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
    host = new RemoteHost({
        api: api.api,
        hostName: 'alphar',
        baton: new Baton(),
        pins,
        shares,
        devices,
        transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } },
    });
    connect = () => { const pair = inMemoryPair(); for (const cb of connections) cb(pair.server); return client(pair.client); };
});

afterEach(async () => {
    // The store's writes are serialized and awaitable; a dir deleted under a pending rename is ENOENT, not a test result.
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

describe('authentication', () => {
    it('a PIN read off this screen pairs a device of the OWNER’s and mints a durable token; the token alone works next time; a wrong PIN is refused and the socket closed', async () => {
        const { code } = host.issuePin();
        expect(code).toBe('482913');
        const a = connect();
        const welcome = await a.hello({ kind: 'pin', code, label: 'glenn’s phone' });
        expect(welcome).toMatchObject({ kind: 'welcome', host: 'alphar', isOwner: true, workspaceId: null, token: 'tok0' });
        expect(devices.list().map((d) => d.label)).toEqual(['glenn’s phone']);

        const b = connect();
        expect(await b.hello({ kind: 'token', token: 'tok0' })).toMatchObject({ kind: 'welcome', isOwner: true });
        expect(devices.list()).toHaveLength(1);

        const c = connect();
        expect(await c.hello({ kind: 'pin', code: '000000' })).toEqual({ kind: 'refused', reason: 'no PIN is active; issue a new one' });
        host.issuePin();
        const d = connect();
        expect(await d.hello({ kind: 'pin', code: '111111' })).toEqual({ kind: 'refused', reason: 'wrong PIN' });
        const e = connect();
        expect(await e.hello({ kind: 'token', token: 'nope' })).toEqual({ kind: 'refused', reason: 'this device is not paired with alphar' });
        expect(host.connections()).toHaveLength(2);
    });

    it('a share link admits a GUEST to its one workspace; another host’s link, an expired or revoked one, is refused', async () => {
        const link = shares.mint({ workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 60_000 });
        const served = shares.serve(link.id) as { ok: true; url: string };
        const secret = new URL(served.url).hash.slice(1);
        const g = connect();
        expect(await g.hello({ kind: 'share', id: link.id, secret })).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId: 'tynn' });
        const bad = connect();
        expect(await bad.hello({ kind: 'share', id: link.id, secret: 'wrong' })).toEqual({ kind: 'refused', reason: 'not a valid link' });
        shares.revoke(link.id);
        const r = connect();
        expect(await r.hello({ kind: 'share', id: link.id, secret })).toEqual({ kind: 'refused', reason: 'this link was revoked' });
    });

    it('a call before hello is refused; a frame that is not a message is refused with the parse reason', async () => {
        const x = connect();
        expect(await x.call('snapshot')).toEqual({ kind: 'refused', reason: 'say hello first' });
    });
});

describe('reads, writes, the baton', () => {
    async function owner(label: string) {
        host.issuePin();
        const c = connect();
        await c.hello({ kind: 'pin', code: '482913', label });
        return c;
    }

    it('a read is never gated; a write needs the baton; the baton is one connection’s until released or lost', async () => {
        const a = await owner('laptop');
        const b = await owner('phone');
        expect(await a.call('snapshot')).toMatchObject({ kind: 'result', ok: true, value: { agents: snapshot.agents } });
        expect(await a.call('openAgent', 'agent_a')).toEqual({ kind: 'result', id: 2, ok: false, reason: 'nobody is driving alphar; take the baton to make changes' });
        expect(await a.call('baton.take')).toMatchObject({ kind: 'result', ok: true });
        expect(await a.call('openAgent', 'agent_a')).toMatchObject({ kind: 'result', ok: true, value: { ok: true } });
        expect(api.calls.filter((c) => c.method === 'openAgent')).toEqual([{ method: 'openAgent', args: ['agent_a'] }]);

        expect(await b.call('baton.take')).toEqual({ kind: 'result', id: 1, ok: false, reason: 'laptop is driving alphar' });
        expect(await b.call('prompt', 'agent_a', 'hi')).toEqual({ kind: 'result', id: 2, ok: false, reason: 'laptop is driving; take the baton to make changes' });
        expect(await b.call('baton.status')).toMatchObject({ ok: true, value: { driver: 'laptop', mine: false, locked: false } });

        a.close();
        await new Promise((r) => setTimeout(r, 0));
        expect(await b.call('baton.take')).toMatchObject({ ok: true });
        expect(await b.call('prompt', 'agent_a', 'hi')).toMatchObject({ ok: true });
    });

    // Tynn #845 (the two-VM proof, 2026-10-20): Upgrade host said "nobody is driving … take the baton" — check and
    // download were writes. The whole upgrade is the OWNER acting on the host: no baton, and still never a guest.
    it('Upgrade host, all three steps, by the owner WITHOUT the baton; a guest is refused each (CONTROL)', async () => {
        const o = await owner('laptop');
        expect(await o.call('updates.check')).toMatchObject({ ok: true });
        expect(await o.call('updates.download')).toMatchObject({ ok: true });
        expect(await o.call('updates.install')).toMatchObject({ ok: true });
        const link = shares.mint({ workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 60_000 });
        const secret = new URL((shares.serve(link.id) as { url: string }).url).hash.slice(1);
        const guest = connect();
        await guest.hello({ kind: 'share', id: link.id, secret }, 'wren');
        await guest.call('baton.take');
        for (const step of ['updates.check', 'updates.download', 'updates.install']) {
            expect(await guest.call(step)).toMatchObject({ ok: false });
        }
    });

    it('an upgrade is gated on OWNERSHIP, not the baton; lock is the owner’s kill-switch for every write', async () => {
        const link = shares.mint({ workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 60_000 });
        const secret = new URL((shares.serve(link.id) as { url: string }).url).hash.slice(1);
        const guest = connect();
        await guest.hello({ kind: 'share', id: link.id, secret }, 'wren');
        expect(await guest.call('baton.take')).toMatchObject({ ok: true });
        expect(await guest.call('updates.install')).toEqual({ kind: 'result', id: 2, ok: false, reason: 'only the host owner may upgrade this Genie' });
        expect(await guest.call('host.lock')).toEqual({ kind: 'result', id: 3, ok: false, reason: 'only the host owner may lock alphar' });

        const o = await owner('laptop');
        expect(await o.call('updates.install')).toMatchObject({ ok: true, value: { report: 'stopped 2 processes' } });
        expect(await o.call('host.lock')).toMatchObject({ ok: true });
        expect(await guest.call('prompt', 'agent_a', 'x')).toEqual({ kind: 'result', id: 4, ok: false, reason: 'this Genie is locked' });
        expect(await guest.call('snapshot')).toMatchObject({ ok: true });
        expect(await o.call('host.unlock')).toMatchObject({ ok: true });
    });

    it('host-only methods are refused with where to do them', async () => {
        const a = await owner('laptop');
        await a.call('baton.take');
        expect(await a.call('addWorkspace')).toEqual({ kind: 'result', id: 2, ok: false, reason: 'addWorkspace opens a folder picker on alphar; do it there' });
        expect(await a.call('takeOver', 'agent_a')).toEqual({ kind: 'result', id: 3, ok: false, reason: 'takeOver opens a window on alphar; do it there' });
        expect(await a.call('features.setBrowserBounds', { x: 0, y: 0, width: 1, height: 1 })).toMatchObject({ ok: false });
        expect(api.calls.map((c) => c.method)).not.toContain('addWorkspace');
    });
});

describe('a guest’s scope', () => {
    it('sees only its workspace in the snapshot and in events, and cannot touch an agent outside it', async () => {
        const link = shares.mint({ workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 60_000 });
        const secret = new URL((shares.serve(link.id) as { url: string }).url).hash.slice(1);
        const g = connect();
        await g.hello({ kind: 'share', id: link.id, secret }, 'wren');
        const snap = await g.call('snapshot');
        expect(snap).toMatchObject({ ok: true, value: { agents: [snapshot.agents[0]], workspaces: [snapshot.workspaces[0]], deckItems: [snapshot.deckItems[0]] } });
        await g.call('baton.take');
        expect(await g.call('openAgent', 'agent_b')).toMatchObject({ ok: false, reason: 'agent_b is not in the workspace this link shares' });
        expect(await g.call('openAgent', 'agent_a')).toMatchObject({ ok: true });

        host.issuePin();
        const o = connect();
        await o.hello({ kind: 'pin', code: '482913', label: 'laptop' });
        api.emit('snapshot', snapshot);
        expect(await o.next()).toMatchObject({ kind: 'event', channel: 'snapshot', payload: { agents: snapshot.agents } });
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'snapshot', payload: { agents: [snapshot.agents[0]] } });
    });
});

describe('a guest receives ONLY its workspace’s pushes (beta.33 item 26, SECURITY)', () => {
    /*
     * Found by builder-lanes (2026-10-20): every push but the snapshot went to EVERY connection — another workspace's
     * agents' ledgers (`agent:<id>`), its terminals' output (`terminal-data` / `terminal-exit`), the host's features and
     * update state. A guest's link reaches one workspace; every push to it is scoped by the same rule its requests are,
     * and anything that cannot be placed in its workspace is not sent to it. The owner still receives everything.
     *
     * "Received nothing" is proved by a positive control in the same stream: after each push a guest must not see, a push
     * it may see (its own agent) is sent, and that is the next thing it receives.
     */
    async function guestAndOwner() {
        const link = shares.mint({ workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 60_000 });
        const secret = new URL((shares.serve(link.id) as { url: string }).url).hash.slice(1);
        const g = connect();
        await g.hello({ kind: 'share', id: link.id, secret }, 'wren');
        host.issuePin();
        const o = connect();
        await o.hello({ kind: 'pin', code: '482913', label: 'laptop' });
        return { g, o };
    }
    const ownAgent = { agent: { id: 'agent_a' }, rows: [] };

    const leaks: Array<[string, string, unknown]> = [
        ['another workspace’s agent ledger', 'agent:agent_b', { agent: { id: 'agent_b' }, rows: [{ text: 'fancy secrets' }] }],
        ['another workspace’s terminal output', 'terminal-data', { id: 'term_f', data: 'fancy shell output' }],
        ['another workspace’s terminal exit', 'terminal-exit', { id: 'term_f', exitCode: 0 }],
        ['a terminal nobody can place', 'terminal-data', { id: 'term_unknown', data: 'x' }],
        ['the host’s features (every workspace’s hosting)', 'features', { hosting: { sites: ['fancy.gen'] } }],
        ['the host’s update state', 'updates', { phase: 'ready' }],
        ['a channel the host has not classified', 'something-new', { any: 'thing' }],
    ];
    for (const [what, channel, payload] of leaks) {
        it(`never: ${what} — while the owner still receives it`, async () => {
            const { g, o } = await guestAndOwner();
            api.emit(channel, payload);
            expect(await o.next()).toMatchObject({ kind: 'event', channel });
            api.emit('agent:agent_a', ownAgent);
            expect(await g.next()).toMatchObject({ kind: 'event', channel: 'agent:agent_a' });
        });
    }

    it('its own: its agent’s ledger, its terminals’ output and exit (CONTROL — the filter is not "send a guest nothing")', async () => {
        const { g } = await guestAndOwner();
        api.emit('terminal-data', { id: 'term_t', data: 'tynn shell output' });
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'terminal-data', payload: { id: 'term_t' } });
        api.emit('terminal-exit', { id: 'term_t', exitCode: 0 });
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'terminal-exit', payload: { id: 'term_t' } });
        api.emit('agent:agent_a', ownAgent);
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'agent:agent_a' });
    });
});
