import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { REMOTE_PROTOCOL, inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

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
            if (method === 'features.snapshot') return { settings: { values: { theme: 'dark' } }, remote: { url: 'wss://alphar', pin: { code: '771122', expiresAt: 9 }, devices: [{ id: 'd1', label: 'owner phone' }], connections: [{ id: 'c1', label: 'laptop' }], enabled: true } };
            if (method === 'openAgent') return { ok: true };
            if (method === 'updates.install') return { report: 'stopped 2 processes' };
            return { ok: true };
        },
        onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        workspaceOfAgent: (id) => snapshot.agents.find((a) => a.id === id)?.workspaceId ?? null,
        workspaceOfTerminal: (id) => ({ term_t: 'tynn', term_f: 'fancy' } as Record<string, string>)[id] ?? null,
    };
    return { api, calls, listening: () => listeners.size, emit: (channel: string, payload: unknown) => { for (const l of listeners) l(channel, payload); } };
}

/** A client end: send a frame, await the next frame(s). */
function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async (auth: unknown, label = 'phone') => { t.send(JSON.stringify({ kind: 'hello', auth, label })); let m = await next(); while (m.kind === 'pairing') m = await next(); return m; },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
        next,
        close: () => t.close(),
    };
}

let dir: string;
let host: RemoteHost;
let api: ReturnType<typeof fakeApi>;
let pins: PairingPins;
let devices: DeviceStore;
let now = 1_000_000;
let connect: () => ReturnType<typeof client>;
/** A connection the Tynn relay admitted: the transport proved who it is (relay-host.ts sets `preAuth`). */
let connectRelay: (who: PreAuth) => ReturnType<typeof client>;
/** A guest a Tynn share link admitted to one workspace, over the relay (the only way a guest comes in). */
async function tynnLinkGuest(workspaceId: string) {
    const g = connectRelay({ label: 'wren', isOwner: false, workspaceId, readonly: false });
    expect(await g.hello({ kind: 'relay' }, 'wren')).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId });
    return g;
}
/** How many "Pair this device?" prompts were raised on this screen. */
let pairPrompts = 0;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-remote-host-'));
    api = fakeApi();
    pins = new PairingPins({ now: () => now, random: () => 0.482913 });
    devices = await DeviceStore.open(dir, { now: () => now, random: () => 'tok' + (devices?.list().length ?? 0) });
    const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
    pairPrompts = 0;
    host = new RemoteHost({ confirm: { ask: (input) => { pairPrompts += 1; return allowEveryPairing.ask(input); }, cancel: allowEveryPairing.cancel },
        api: api.api,
        hostName: 'alphar',
        baton: new Baton(),
        pins,
        devices,
        build: '2.0.0-beta.57+0123456789ab',
        transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } },
    });
    connect = () => { const pair = inMemoryPair(); for (const cb of connections) cb(pair.server); return client(pair.client); };
    connectRelay = (who) => { const pair = inMemoryPair(); for (const cb of connections) cb({ ...pair.server, remoteAddress: 'relay:wren', preAuth: who }); return client(pair.client); };
});

afterEach(async () => {
    // The store's writes are serialized and awaitable; a dir deleted under a pending rename is ENOENT, not a test result.
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

/**
 * THE VERSION HANDSHAKE (P10.1e). A desktop window reaching a host over the relay — genie-cloud's, P10 — reads what it is
 * talking to in `welcome`: the remote wire's `protocol` and the host's `build`. Additive only: every field an old client
 * reads is there as before, so an old client is unaffected.
 */
describe('the welcome says the protocol and the build', () => {
    const OLD_FIELDS = ['connectionId', 'host', 'isOwner', 'kind', 'workspaceId'];

    it('a PIN pairing: the old fields as before, with protocol and build beside them', async () => {
        const { code } = host.issuePin();
        const welcome = await connect().hello({ kind: 'pin', code, label: 'glenn’s phone' });
        expect(welcome).toEqual({ kind: 'welcome', connectionId: expect.any(String), host: 'alphar', isOwner: true, workspaceId: null, token: 'tok0', protocol: REMOTE_PROTOCOL, build: '2.0.0-beta.57+0123456789ab' });
        expect(REMOTE_PROTOCOL).toBe(1);
    });

    it('a token hello and a relay guest say them too, and nothing else is added', async () => {
        const { code } = host.issuePin();
        await connect().hello({ kind: 'pin', code, label: 'glenn’s phone' });
        const again = await connect().hello({ kind: 'token', token: 'tok0' });
        expect(Object.keys(again).sort()).toEqual([...OLD_FIELDS, 'build', 'protocol'].sort());
        expect(again).toMatchObject({ protocol: REMOTE_PROTOCOL, build: '2.0.0-beta.57+0123456789ab' });
        const guest = await connectRelay({ label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false }).hello({ kind: 'relay' }, 'wren');
        expect(guest).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId: 'tynn', protocol: REMOTE_PROTOCOL, build: '2.0.0-beta.57+0123456789ab' });
    });

    it('an OLD client reads the new welcome as it always has: the parser takes it, and its fields are unchanged', () => {
        const parsed = parseMessage(JSON.stringify({ kind: 'welcome', connectionId: 'c1', host: 'alphar', isOwner: true, workspaceId: null, protocol: REMOTE_PROTOCOL, build: 'b' }));
        expect(parsed).toMatchObject({ ok: true, message: { kind: 'welcome', connectionId: 'c1', host: 'alphar', isOwner: true, workspaceId: null } });
        // CONTROL: a welcome from an OLD host, with neither, still parses.
        expect(parseMessage(JSON.stringify({ kind: 'welcome', connectionId: 'c1', host: 'alphar', isOwner: true, workspaceId: null }))).toMatchObject({ ok: true });
    });
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

    it('a call before hello is refused; a frame that is not a message is refused with the parse reason', async () => {
        const x = connect();
        expect(await x.call('snapshot')).toEqual({ kind: 'refused', reason: 'say hello first' });
    });
});

describe('a relay connection says only a relay hello (SECURITY, pairing vs share link H1)', () => {
    /*
     * Pairing is the owner's: whole-workstation access, never approved again. A share link is another person's single
     * session and NEVER pairs. A connection the Tynn relay admitted is already somebody, proved by its Tynn grant; if it
     * could also say a PIN, device-token or local-link hello, a guest admitted by a link could leave as a paired owner
     * with a durable token. Over the relay, the grant is the only way in; PIN, token and link are tailnet/local only.
     */
    const linkGuest: PreAuth = { label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false };
    const hostGuest: PreAuth = { label: 'wren', isOwner: false, workspaceId: null, readonly: false };
    const refusedAsRelay = { kind: 'refused', reason: expect.stringContaining('Tynn relay') };

    it('a PIN hello on a relay socket is refused, raises no "Pair this device?" and pairs nothing; the same PIN on the tailnet does (CONTROL)', async () => {
        const { code } = host.issuePin();
        for (const who of [linkGuest, hostGuest]) {
            const r = connectRelay(who);
            expect(await r.hello({ kind: 'pin', code, label: 'wren laptop' })).toMatchObject(refusedAsRelay);
        }
        expect(pairPrompts).toBe(0);
        expect(devices.list()).toEqual([]);
        expect(host.connections()).toEqual([]);
        // CONTROL: the PIN was not spent by the refused hellos, and on the tailnet it raises the prompt and pairs.
        const t = connect();
        expect(await t.hello({ kind: 'pin', code, label: 'glenn’s phone' })).toMatchObject({ kind: 'welcome', isOwner: true });
        expect(pairPrompts).toBe(1);
        expect(devices.list().map((d) => d.label)).toEqual(['glenn’s phone']);
    });

    it('a device-token hello on a relay socket is refused, not welcomed as the owner; the same token on the tailnet is (CONTROL)', async () => {
        const { code } = host.issuePin();
        const phone = connect();
        const paired = await phone.hello({ kind: 'pin', code, label: 'glenn’s phone' }) as { token: string };
        const r = connectRelay(linkGuest);
        expect(await r.hello({ kind: 'token', token: paired.token })).toMatchObject(refusedAsRelay);
        // Only the phone itself is connected: the relay socket was not admitted under the phone's pairing.
        expect(host.connections().map((c) => c.label)).toEqual(['glenn’s phone']);
        const t = connect();
        expect(await t.hello({ kind: 'token', token: paired.token })).toMatchObject({ kind: 'welcome', isOwner: true });
    });

    it('the relay hello on a relay socket takes the grant’s principal (CONTROL); a relay hello without one is refused', async () => {
        const r = connectRelay(linkGuest);
        expect(await r.hello({ kind: 'relay' })).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId: 'tynn' });
        const t = connect();
        expect(await t.hello({ kind: 'relay' })).toEqual({ kind: 'refused', reason: 'this connection did not come through the Tynn relay' });
    });
});

describe('the host API is listened to only while someone is connected (genie#1200)', () => {
    /*
     * The owner, 2026-10-26: "The UI is still laggy with the number of agents I have going right now." Listening to the host
     * API builds an agent's whole detail on every update of every agent (host-api.ts), for #broadcast to send to NO ONE when
     * no device is connected — which is always, until the socket is wired. Measured on the owner's machine: main at 78–98 %
     * of a core for seconds at a time.
     */
    const settled = () => new Promise((r) => setTimeout(r, 0));
    it('nothing connected: not listening; an authenticated connection: listening and receiving; it closes: not listening', async () => {
        expect(api.listening()).toBe(0);
        const { code } = host.issuePin();
        const a = connect();
        await a.hello({ kind: 'pin', code, label: 'phone' });
        expect(api.listening()).toBe(1);
        api.emit('snapshot', snapshot);
        expect(await a.next()).toMatchObject({ kind: 'event', channel: 'snapshot' });
        a.close(); await settled();
        expect(api.listening()).toBe(0);
    });

    it('a connection that never authenticates does not start the listening; two connections listen ONCE, until the last closes', async () => {
        const stranger = connect();
        expect(await stranger.hello({ kind: 'token', token: 'nope' })).toMatchObject({ kind: 'refused' });
        expect(api.listening()).toBe(0);
        const { code } = host.issuePin();
        const a = connect();
        await a.hello({ kind: 'pin', code, label: 'phone' });
        const b = connect();
        await b.hello({ kind: 'token', token: 'tok0' });
        expect(api.listening()).toBe(1);
        a.close(); await settled();
        expect(api.listening()).toBe(1);
        b.close(); await settled();
        expect(api.listening()).toBe(0);
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
        const guest = await tynnLinkGuest('tynn');
        await guest.call('baton.take');
        for (const step of ['updates.check', 'updates.download', 'updates.install']) {
            expect(await guest.call(step)).toMatchObject({ ok: false });
        }
    });

    // Add workspace parity 11: New can now create a GitHub repository with the HOST's GitHub sign-in and push to it, and
    // declare it on the host owner's Tynn project. Like every other add route, it changes the host itself: owner only.
    it('New workspace (which may create a repository under the host owner’s GitHub) is the owner’s: a guest is refused (CONTROL: the owner)', async () => {
        const guest = await tynnLinkGuest('tynn');
        expect(await guest.call('baton.take')).toMatchObject({ ok: true });
        expect(await guest.call('workspaces.create', 'acme', '/w', { kind: 'github', owner: 'ada', private: true })).toMatchObject({ ok: false, reason: expect.stringContaining('only its owner can') });
        // The control: the same call by the owner, once the guest has handed the baton back, goes through.
        expect(await guest.call('baton.release')).toMatchObject({ ok: true });
        const o = await owner('laptop');
        expect(await o.call('baton.take')).toMatchObject({ ok: true });
        expect(await o.call('workspaces.create', 'acme', '/w', { kind: 'none' })).toMatchObject({ ok: true });
    });

    it('a workspace guest cannot use the owner pairing to read or triage Issues (CONTROL: the owner)', async () => {
        const guest = await tynnLinkGuest('tynn');
        expect(await guest.call('baton.take')).toMatchObject({ ok: true });
        for (const method of ['workspaces.tynnIssues', 'workspaces.tynnIssueAction', 'workspaces.tynnPageAction'] as const) {
            expect(await guest.call(method, 'tynn', {})).toMatchObject({ ok: false, reason: expect.stringContaining('only its owner can') });
            expect(api.calls.map((c) => c.method)).not.toContain(method);
        }
        expect(await guest.call('baton.release')).toMatchObject({ ok: true });
        const o = await owner('laptop');
        expect(await o.call('baton.take')).toMatchObject({ ok: true });
        for (const method of ['workspaces.tynnIssues', 'workspaces.tynnIssueAction', 'workspaces.tynnPageAction'] as const) {
            expect(await o.call(method, 'tynn', {})).toMatchObject({ ok: true });
            expect(api.calls.map((c) => c.method)).toContain(method);
        }
    });

    it('an upgrade is gated on OWNERSHIP, not the baton; lock is the owner’s kill-switch for every write', async () => {
        const guest = await tynnLinkGuest('tynn');
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
        const g = await tynnLinkGuest('tynn');
        const snap = await g.call('snapshot');
        expect(snap).toMatchObject({ ok: true, value: { agents: [snapshot.agents[0]], workspaces: [snapshot.workspaces[0]], deckItems: [snapshot.deckItems[0]] } });
        await g.call('baton.take');
        expect(await g.call('openAgent', 'agent_b')).toMatchObject({ ok: false, reason: 'agent_b is not in the workspace this link shares' });
        expect(await g.call('openAgent', 'agent_a')).toMatchObject({ ok: true });
        expect(await g.call('resolvePrompt', 'agent_b', 'draft1', 'send')).toMatchObject({ ok: false, reason: 'agent_b is not in the workspace this link shares' });
        expect(await g.call('resolvePrompt', 'agent_a', 'draft1', 'discard')).toMatchObject({ ok: true });

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
        const g = await tynnLinkGuest('tynn');
        host.issuePin();
        const o = connect();
        await o.hello({ kind: 'pin', code: '482913', label: 'laptop' });
        return { g, o };
    }
    const ownAgent = { agent: { id: 'agent_a' }, rows: [] };

    // SECURITY (genie#872): the feature snapshot carries the LIVE pairing PIN, the paired devices, the share links and the
    // connections. A guest who read the PIN could pair as an OWNER. A guest gets the snapshot without them; the owner still
    // gets all of it (positive control).
    it('a guest’s features.snapshot carries no pairing PIN, devices or connections; the owner’s does', async () => {
        const { g, o } = await guestAndOwner();
        const guest = JSON.stringify(await g.call('features.snapshot'));
        const owner = JSON.stringify(await o.call('features.snapshot'));
        expect(owner).toContain('771122');
        expect(owner).toContain('owner phone');
        for (const secret of ['771122', 'owner phone', '"c1"']) expect(guest).not.toContain(secret);
        expect(guest).toContain('"theme":"dark"'); // CONTROL: the guest still gets the rest of the snapshot
    });

    const leaks: Array<[string, string, unknown]> = [
        ['another workspace’s agent ledger', 'agent:agent_b', { agent: { id: 'agent_b' }, rows: [{ text: 'fancy secrets' }] }],
        ['another workspace’s agent activity (the Dashboard lanes, beta.33 item 10)', 'activity', { agentId: 'agent_b', items: [{ text: 'fancy secrets' }] }],
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
        api.emit('activity', { agentId: 'agent_a', items: [] });
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'activity', payload: { agentId: 'agent_a' } });
    });
});

describe('a whole-workstation guest never receives the remote secrets in a push (SECURITY, pairing vs share link H2)', () => {
    /*
     * genie#872 emptied the remote section of the `features.snapshot` CALL for a non-owner, but the same snapshot is also
     * PUSHED on `features` whenever settings or flows change, and a guest of the whole workstation (a Tynn link with
     * `host:all`: not the owner, no one workspace) skipped the workspace filter and received it whole: the live PIN,
     * the paired devices, the local share links and the connections. Every push to a non-owner goes through one
     * deny-by-default filter now; the owner still receives everything (positive control).
     */
    const hostGuest: PreAuth = { label: 'wren', isOwner: false, workspaceId: null, readonly: false };
    const features = { settings: { values: { theme: 'dark' } }, remote: { url: 'wss://alphar', pin: { code: '771122', expiresAt: 9 }, devices: [{ id: 'd1', label: 'owner phone' }], connections: [{ id: 'c1', label: 'laptop' }], pairRequests: [{ id: 'pair_1' }], enabled: true } };
    const SECRETS = ['771122', 'owner phone', '"c1"', 'pair_1'];

    async function hostGuestAndOwner() {
        const g = connectRelay(hostGuest);
        expect(await g.hello({ kind: 'relay' })).toMatchObject({ kind: 'welcome', isOwner: false, workspaceId: null });
        host.issuePin();
        const o = connect();
        await o.hello({ kind: 'pin', code: '482913', label: 'laptop' });
        return { g, o };
    }

    it('the `features` push to a whole-workstation guest carries no PIN, devices or connections; the owner’s push does', async () => {
        const { g, o } = await hostGuestAndOwner();
        api.emit('features', features);
        const owner = JSON.stringify(await o.next());
        const guest = await g.next();
        expect(guest).toMatchObject({ kind: 'event', channel: 'features' });
        const text = JSON.stringify(guest);
        for (const secret of SECRETS) expect(text).not.toContain(secret);
        expect(text).toContain('"theme":"dark"'); // CONTROL: the rest of the snapshot still arrives
        for (const secret of ['771122', 'owner phone', '"c1"']) expect(owner).toContain(secret);
        expect(owner).not.toContain('pair_1'); // Allow is pressed on this screen only, for every remote (q_8c07b142)
    });

    it('the call and the push agree: the guest’s `features.snapshot` call is redacted too (genie#872, unchanged)', async () => {
        const { g } = await hostGuestAndOwner();
        const called = JSON.stringify(await g.call('features.snapshot'));
        for (const secret of ['771122', 'owner phone', '"c1"']) expect(called).not.toContain(secret);
    });

    // Deny by default: a channel the host has not classified, or one carrying a remote section, is not sent at all.
    const withheld: Array<[string, string, unknown]> = [
        ['a channel the host has not classified (even one carrying a remote section)', 'something-new', { remote: { pin: { code: '771122' } } }],
        ['the host’s update state (a whole-workstation guest may not act on updates)', 'updates', { phase: 'ready' }],
    ];
    for (const [what, channel, payload] of withheld) {
        it(`never: ${what} — while the owner still receives it`, async () => {
            const { g, o } = await hostGuestAndOwner();
            api.emit(channel, payload);
            expect(await o.next()).toMatchObject({ kind: 'event', channel });
            api.emit('agent:agent_b', { agent: { id: 'agent_b' }, rows: [] });
            expect(await g.next()).toMatchObject({ kind: 'event', channel: 'agent:agent_b' });
        });
    }

    it('still receives the whole workstation: every workspace’s snapshot, agents, activity and terminals (CONTROL)', async () => {
        const { g } = await hostGuestAndOwner();
        api.emit('snapshot', snapshot);
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'snapshot', payload: { agents: snapshot.agents } });
        api.emit('agent:agent_b', { agent: { id: 'agent_b' }, rows: [] });
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'agent:agent_b' });
        api.emit('activity', { agentId: 'agent_b', items: [] });
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'activity' });
        api.emit('terminal-data', { id: 'term_f', data: 'fancy shell output' });
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'terminal-data' });
        api.emit('terminal-exit', { id: 'term_f', exitCode: 0 });
        expect(await g.next()).toMatchObject({ kind: 'event', channel: 'terminal-exit' });
    });
});
