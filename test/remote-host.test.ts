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
            // Tynn #529 part A: the host's Take Over host started (or reused) the TUI, with no window here.
            if (method === 'takeOver') return { ok: true, terminalId: 'term_t', started: takeOverStarts };
            return { ok: true };
        },
        onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        workspaceOfAgent: (id) => snapshot.agents.find((a) => a.id === id)?.workspaceId ?? null,
        workspaceOfTerminal: (id) => ({ term_t: 'tynn', term_f: 'fancy' } as Record<string, string>)[id] ?? null,
    };
    // The Take Over window on the other machine closed: the host ends the TUI it started for it (Tynn #529 part A).
    Object.assign(api, { takeOverEnded: (terminalId: string) => { ended.push(terminalId); } });
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
/** Whether the host's Take Over host STARTED the TUI (false: one was already open here). */
let takeOverStarts = true;
/** The TUIs the host was told to end. */
let ended: string[] = [];
/** The host's timers, run by hand. */
let timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
const schedule = (ms: number, fn: () => void) => { const t = { ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
const runTimers = () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-remote-host-'));
    api = fakeApi();
    pins = new PairingPins({ now: () => now, random: () => 0.482913 });
    devices = await DeviceStore.open(dir, { now: () => now, random: () => 'tok' + (devices?.list().length ?? 0) });
    const connections: Array<(c: ReturnType<typeof inMemoryPair>['server']) => void> = [];
    pairPrompts = 0;
    takeOverStarts = true;
    ended = [];
    timers = [];
    host = new RemoteHost({
        ...({ schedule } as object), now: () => now, confirm: { ask: (input) => { pairPrompts += 1; return allowEveryPairing.ask(input); }, cancel: allowEveryPairing.cancel },
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

/**
 * TAKING CONTROL (Tynn #529). The owner, connected from a Pilot to a drone, saw "nobody is driving aion; take the baton
 * to make changes" and had no way to take it. The host's baton is fine on its own; what a window needs from it is a way to
 * take control from whoever holds it, and to be TOLD, at once and by whom, when it loses control. The rules: the owner may
 * take control from anyone; a guest never from the owner; a read-only grant never. A window that asked (`baton.watch`)
 * hears every change it did not cause itself.
 */
describe('taking control (Tynn #529)', () => {
    async function owner(label: string) {
        host.issuePin();
        const c = connect();
        await c.hello({ kind: 'pin', code: '482913', label });
        return c;
    }
    const BATON = 'remote-baton';

    it('two windows: one takes; the other is told who; the other takes control from it; the first is told at once, by whom; a disconnect releases and is told', async () => {
        const a = await owner('laptop');
        const b = await owner('desk');
        expect(await a.call('baton.watch')).toMatchObject({ kind: 'result', ok: true });
        expect(await b.call('baton.watch')).toMatchObject({ kind: 'result', ok: true });

        expect(await a.call('baton.take')).toMatchObject({ kind: 'result', ok: true, value: { driver: 'laptop', mine: true } });
        expect(await b.next()).toEqual({ kind: 'event', channel: BATON, payload: { driver: 'laptop', mine: false, locked: false, by: 'laptop' } });

        // A plain take never takes control from someone driving: it says who is.
        expect(await b.call('baton.take')).toMatchObject({ kind: 'result', ok: false, reason: 'laptop is driving alphar' });
        // Take control does.
        expect(await b.call('baton.take', { force: true })).toMatchObject({ kind: 'result', ok: true, value: { driver: 'desk', mine: true } });
        expect(await a.next()).toEqual({ kind: 'event', channel: BATON, payload: { driver: 'desk', mine: false, locked: false, by: 'desk' } });
        expect(await a.call('prompt', 'agent_a', 'hi')).toMatchObject({ kind: 'result', ok: false, reason: 'desk is driving; take the baton to make changes' });
        expect(await b.call('prompt', 'agent_a', 'hi')).toMatchObject({ kind: 'result', ok: true });

        // The driver leaves: the baton is released, and the window left is told.
        b.close();
        expect(await a.next()).toEqual({ kind: 'event', channel: BATON, payload: { driver: null, mine: false, locked: false, by: null } });
        expect(await a.call('baton.take')).toMatchObject({ kind: 'result', ok: true });
    });

    it('a guest never takes control from the owner, and says so; the owner takes control from a guest (CONTROL)', async () => {
        const o = await owner('laptop');
        expect(await o.call('baton.take')).toMatchObject({ ok: true });
        const guest = await tynnLinkGuest('tynn');
        expect(await guest.call('baton.take', { force: true })).toMatchObject({ kind: 'result', ok: false, reason: 'laptop is driving alphar, and only the owner can take control from the owner' });
        expect(await o.call('prompt', 'agent_a', 'still mine')).toMatchObject({ ok: true });

        // The control: the guest drives; the owner takes control from it.
        expect(await o.call('baton.release')).toMatchObject({ ok: true });
        expect(await guest.call('baton.take')).toMatchObject({ ok: true });
        expect(await o.call('baton.take', { force: true })).toMatchObject({ ok: true, value: { driver: 'laptop', mine: true } });
        expect(await guest.call('prompt', 'agent_a', 'x')).toMatchObject({ ok: false, reason: 'laptop is driving; take the baton to make changes' });
    });

    it('a read-only grant never takes control, not even from nobody', async () => {
        const o = await owner('laptop');
        expect(await o.call('baton.take')).toMatchObject({ ok: true });
        const ro = connectRelay({ label: 'Pat', isOwner: false, workspaceId: null, readonly: true });
        await ro.hello({ kind: 'relay' }, 'Pat');
        expect(await ro.call('baton.take', { force: true })).toMatchObject({ ok: false, reason: 'Pat has read-only access to alphar' });
        expect(await o.call('baton.status')).toMatchObject({ ok: true, value: { driver: 'laptop', mine: true } });
    });

    it('a window that never asked to watch is sent no baton events (old clients read the wire as before)', async () => {
        const a = await owner('laptop');
        const b = await owner('desk');
        expect(await a.call('baton.take')).toMatchObject({ ok: true });
        // b's next frame is the answer to its own call, not an event it never asked for.
        expect(await b.call('baton.status')).toMatchObject({ kind: 'result', ok: true, value: { driver: 'laptop', mine: false } });
    });
});

/**
 * TAKE OVER FROM ANOTHER MACHINE (Tynn #529 part A). The owner pressed Take over on aion's agent from a Pilot and nothing
 * happened: the host refused it as host-only, and the window dropped the answer. Now the window that DRIVES asks, the host
 * starts the TUI with no window of its own and answers its terminal and a TICKET; the person's machine opens its own Take
 * Over window, whose connection presents the ticket and becomes that window's COMPANION. The ticket's rules: single use;
 * gone ~30 s after it was issued if unused; bound to the window that asked and that terminal; never a guest's, never
 * another device's; it lets the companion type into that one terminal only; revoked the moment the window that asked
 * loses the baton or leaves. Closing the companion ends the TUI it started.
 */
describe('Take over from another machine (Tynn #529 part A)', () => {
    const COMPANION = 'remote-companion';
    async function owner(label: string) {
        host.issuePin();
        const c = connect();
        const w = await c.hello({ kind: 'pin', code: '482913', label });
        return { c, token: (w as { token?: string }).token! };
    }
    async function takeOver(driver: ReturnType<typeof client>) {
        const r = await driver.call('takeOver', 'agent_a');
        expect(r).toMatchObject({ kind: 'result', ok: true, value: { ok: true, terminalId: 'term_t', ticket: expect.any(String) } });
        return (r as { value: { ticket: string } }).value.ticket;
    }
    async function companion(token: string, ticket: string) {
        const c = connect();
        return { c, hello: await c.hello({ kind: 'token', token, companion: ticket }, 'laptop') };
    }

    it('without the baton it is refused, and says so; with it the host starts the TUI and answers its terminal and a ticket', async () => {
        const { c: a } = await owner('laptop');
        expect(await a.call('takeOver', 'agent_a')).toMatchObject({ ok: false, reason: 'nobody is driving alphar; take the baton to make changes' });
        expect(api.calls.map((x) => x.method)).not.toContain('takeOver');
        expect(await a.call('baton.take')).toMatchObject({ ok: true });
        await takeOver(a);
        expect(api.calls.filter((x) => x.method === 'takeOver')).toEqual([{ method: 'takeOver', args: ['agent_a'] }]);
    });

    it('a guest never takes over from another machine', async () => {
        const g = await tynnLinkGuest('tynn');
        expect(await g.call('baton.take')).toMatchObject({ ok: true });
        expect(await g.call('takeOver', 'agent_a')).toMatchObject({ ok: false, reason: 'only the owner of alphar can take over its agents from another machine' });
        expect(api.calls.map((x) => x.method)).not.toContain('takeOver');
    });

    it('the ticket opens ONE companion from the same device: it types into that terminal and nothing else; a second use is refused', async () => {
        const { c: a, token } = await owner('laptop');
        await a.call('baton.take');
        const ticket = await takeOver(a);
        const { c, hello } = await companion(token, ticket);
        expect(hello).toMatchObject({ kind: 'welcome' });
        expect(await c.call('terminals.write', 'term_t', 'ls')).toMatchObject({ kind: 'result', ok: true });
        expect(await c.call('terminals.resize', 'term_t', 120, 40)).toMatchObject({ kind: 'result', ok: true });
        expect(api.calls.filter((x) => x.method.startsWith('terminals.'))).toEqual([{ method: 'terminals.write', args: ['term_t', 'ls'] }, { method: 'terminals.resize', args: ['term_t', 120, 40] }]);
        expect(await c.call('terminals.write', 'term_f', 'x')).toMatchObject({ ok: false, reason: 'this Take Over window types only into its own terminal' });
        expect(await c.call('openAgent', 'agent_a')).toMatchObject({ ok: false, reason: 'this Take Over window types only into its own terminal' });
        expect(await c.call('baton.take')).toMatchObject({ ok: false, reason: 'a Take Over window does not drive; the window it was opened from does' });
        expect(await c.call('takeOver', 'agent_a')).toMatchObject({ ok: false, reason: 'this Take Over window types only into its own terminal' });

        const again = await companion(token, ticket);
        expect(again.hello).toEqual({ kind: 'refused', reason: 'this Take Over ticket was used already, or has expired' });
    });

    it('an unused ticket is gone after 30 s, and the TUI it started with it', async () => {
        const { c: a, token } = await owner('laptop');
        await a.call('baton.take');
        const ticket = await takeOver(a);
        now += 30_001;
        expect((await companion(token, ticket)).hello).toEqual({ kind: 'refused', reason: 'this Take Over ticket was used already, or has expired' });
        expect(ended).toEqual([]);
        runTimers();
        expect(ended).toEqual(['term_t']);
    });

    it('bound to its window: a guest, or another device, presenting it is refused; the window’s own device still can (CONTROL)', async () => {
        const { c: a, token } = await owner('laptop');
        const { token: other } = await owner('desk');
        await a.call('baton.take');
        const ticket = await takeOver(a);
        const g = connectRelay({ label: 'wren', isOwner: false, workspaceId: 'tynn', readonly: false });
        expect(await g.hello({ kind: 'relay', companion: ticket }, 'wren')).toEqual({ kind: 'refused', reason: 'this Take Over ticket belongs to another window' });
        expect((await companion(other, ticket)).hello).toEqual({ kind: 'refused', reason: 'this Take Over ticket belongs to another window' });
        expect((await companion(token, ticket)).hello).toMatchObject({ kind: 'welcome' });
    });

    it('revoked the moment its window loses the baton: the companion is told why, and its typing is refused with it', async () => {
        const { c: a, token } = await owner('laptop');
        await a.call('baton.take');
        const { c } = await companion(token, await takeOver(a));
        const { c: desk } = await owner('desk');
        expect(await desk.call('baton.take', { force: true })).toMatchObject({ ok: true });
        expect(await c.next()).toEqual({ kind: 'event', channel: COMPANION, payload: { revoked: 'desk took control of alphar' } });
        expect(await c.call('terminals.write', 'term_t', 'x')).toMatchObject({ ok: false, reason: 'desk took control of alphar' });
        // Taking it back does not bring an old ticket back to life: Take over again.
        expect(await a.call('baton.take', { force: true })).toMatchObject({ ok: true });
        expect(await c.call('terminals.write', 'term_t', 'x')).toMatchObject({ ok: false, reason: 'desk took control of alphar' });
    });

    it('revoked when its window leaves; an unused ticket goes with it, and so does the TUI it started', async () => {
        const { c: a, token } = await owner('laptop');
        await a.call('baton.take');
        const { c } = await companion(token, await takeOver(a));
        a.close();
        expect(await c.next()).toEqual({ kind: 'event', channel: COMPANION, payload: { revoked: 'the window this was taken over from closed' } });
        expect(await c.call('terminals.write', 'term_t', 'x')).toMatchObject({ ok: false, reason: 'the window this was taken over from closed' });

        const { c: b, token: bt } = await owner('laptop again');
        await b.call('baton.take');
        const unused = await takeOver(b);
        ended = [];
        b.close();
        await new Promise((r) => setTimeout(r, 0));
        expect(ended).toEqual(['term_t']);
        expect((await companion(bt, unused)).hello).toEqual({ kind: 'refused', reason: 'this Take Over ticket was used already, or has expired' });
    });

    it('closing the companion ends the TUI it started; one that was already open on the host is not its to end (CONTROL)', async () => {
        const { c: a, token } = await owner('laptop');
        await a.call('baton.take');
        const { c } = await companion(token, await takeOver(a));
        c.close();
        await new Promise((r) => setTimeout(r, 0));
        expect(ended).toEqual(['term_t']);

        takeOverStarts = false;
        ended = [];
        const { c: c2 } = await companion(token, await takeOver(a));
        c2.close();
        await new Promise((r) => setTimeout(r, 0));
        runTimers();
        expect(ended).toEqual([]);
    });
});
