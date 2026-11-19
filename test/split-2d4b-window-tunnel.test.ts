import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ENGINE_METHODS, ENGINE_PROTOCOL } from '../src/core/engine-protocol.js';
import { LOCAL_FRAME_LIMIT_BYTES } from '../src/core/local-frame.js';
import { memoryPair } from '../src/core/line-transport.js';
import { inMemoryPair, LOCAL_EVENTS, parseMessage, transportHub, type CallContext, type ClientTransport, type PreAuth, type ServerConnection, type ServerTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { FeatureCallers, type FeatureBrowser } from '../src/main/feature-callers.js';
import { buildHostApi, type HostApi, type HostApiDeps } from '../src/main/host-api.js';
import { hostLocalPorts, type HostLocalSources } from '../src/main/host-local-ports.js';
import { ProtocolTunnels, type TunnelBinding, type TunnelEvent } from '../src/main/protocol-tunnels.js';
import { hostRemoteApi, RemoteAccessHost } from '../src/main/remote-access-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { tunnelDoor, tunnelLinkOf, windowOpsHandler } from '../src/main/window-tunnel.js';

/**
 * CLIENT/HOST SPLIT STEP 2d-4b (Tynn #898, story #910): THE WINDOW'S PROTOCOL CONNECTION RIDES THE ENGINE LINK TO
 * GENIE-HOST'S REMOTEHOST. Until now main's own RemoteHost served this machine's window (local-protocol-door.ts →
 * remoteHub.add(localDoor) in main.ts), while genie-host's RemoteHost served everyone else. A Pilot's typing, taken by
 * genie-host since step 2d-1, was published to genie-host's connections only, so this machine's window never showed it
 * (Tynn #730). Now main forwards each door connection over the engine link (`engine.protocol`, back as `protocol.frame`)
 * and genie-host admits it as this machine's window. What only a window can do stays the window's: the OS trash, an
 * app's window, and the feature effects (a browser page, a sign-in), each asked of the window that owns the connection.
 * Names are fixtures, never real ones.
 */

const TOKEN = 'd'.repeat(64);
const LABEL = 'this Genie window';
const LOCAL_MAIN: PreAuth = { kind: 'local', label: LABEL, isOwner: true, workspaceId: null, readonly: false, window: 'main' };
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

interface Linked {
    readonly server: SessionEngineServer;
    readonly client: SessionEngineClient;
    readonly events: TunnelEvent[];
    readonly windowSide: ClientTransport;
    readonly ops: Array<[string, unknown[]]>;
    readonly effects: Array<[string, string, unknown[]]>;
}

/** One window process's engine link to genie-host: local (its own pipe, token-checked) unless said otherwise. */
async function linkTo(tunnels: ProtocolTunnels, options: { local?: boolean; server?: SessionEngineServer } = {}): Promise<Linked> {
    const server = options.server ?? new SessionEngineServer({ token: TOKEN, build: 't', protocol: tunnels });
    const [hostSide, windowSide] = memoryPair();
    server.accept(hostSide, { local: options.local ?? true });
    const ops: Array<[string, unknown[]]> = [];
    const effects: Array<[string, string, unknown[]]> = [];
    const client = new SessionEngineClient({
        onWindowOp: async (op, args) => { ops.push([op, args]); return 'done'; },
        onFeatureEffect: async (connectionId, method, args) => { effects.push([connectionId, method, args]); return { value: 'shown', browser: null }; },
    });
    expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
    const events: TunnelEvent[] = [];
    client.onProtocolFrame((event) => events.push(event));
    cleanups.push(() => windowSide.close());
    return { server, client, events, windowSide, ops, effects };
}

function admitted(tunnels: ProtocolTunnels) {
    const connections: ServerConnection[] = [];
    const heard: string[][] = [];
    const closed: number[] = [];
    tunnels.onConnection((c) => {
        const i = connections.push(c) - 1;
        heard[i] = [];
        c.onMessage((t) => heard[i]!.push(t));
        c.onClose(() => closed.push(i));
    });
    return { connections, heard, closed };
}

describe('the tunnel on the engine link (genie-host side)', () => {
    it('is on the engine protocol, which says so with a new number', () => {
        expect(ENGINE_METHODS).toContain('engine.protocol');
        expect(ENGINE_METHODS).toContain('client.windowOp');
        expect(ENGINE_PROTOCOL).toBe(4);
    });

    it('a local window opens one: genie-host admits it as this machine’s window, and frames cross both ways', async () => {
        const tunnels = new ProtocolTunnels();
        const seen = admitted(tunnels);
        const l = await linkTo(tunnels);
        expect(l.client.protocolSend('open', 't1', { window: 'main', label: LABEL })).toBe(true);
        await settle();
        expect(seen.connections).toHaveLength(1);
        expect(seen.connections[0]!.preAuth).toEqual(LOCAL_MAIN);
        l.client.protocolSend('frame', 't1', '{"kind":"hello"}');
        await settle();
        expect(seen.heard[0]).toEqual(['{"kind":"hello"}']);
        seen.connections[0]!.send('{"kind":"event","channel":"x","payload":null}');
        await settle();
        expect(l.events).toEqual([{ tunnel: 't1', kind: 'frame', text: '{"kind":"event","channel":"x","payload":null}' }]);
    });

    it('a window showing another workstation is admitted as one (its own origin, Tynn #578)', async () => {
        const tunnels = new ProtocolTunnels();
        const seen = admitted(tunnels);
        const l = await linkTo(tunnels);
        l.client.protocolSend('open', 't2', { window: 'remote', label: LABEL });
        await settle();
        expect(seen.connections[0]!.preAuth).toEqual({ ...LOCAL_MAIN, window: 'remote' });
    });

    it('CONTROL: a link that is not this machine’s own endpoint opens none, and is told why', async () => {
        const tunnels = new ProtocolTunnels();
        const seen = admitted(tunnels);
        const l = await linkTo(tunnels, { local: false });
        l.client.protocolSend('open', 't1', { window: 'main', label: LABEL });
        await settle();
        expect(seen.connections).toEqual([]);
        expect(l.events).toHaveLength(1);
        expect(l.events[0]).toMatchObject({ tunnel: 't1', kind: 'closed' });
        expect((l.events[0] as { reason: string }).reason).toMatch(/own window/);
    });

    it('CONTROL: a frame for a tunnel that is not open reaches nobody', async () => {
        const tunnels = new ProtocolTunnels();
        const seen = admitted(tunnels);
        const l = await linkTo(tunnels);
        l.client.protocolSend('frame', 'nope', '{"kind":"hello"}');
        await settle();
        expect(seen.connections).toEqual([]);
        expect(l.events).toEqual([{ tunnel: 'nope', kind: 'closed', reason: expect.any(String) }]);
    });

    it('the engine link closing ends every connection it tunnelled', async () => {
        const tunnels = new ProtocolTunnels();
        const seen = admitted(tunnels);
        const l = await linkTo(tunnels);
        l.client.protocolSend('open', 't1', { window: 'main', label: LABEL });
        l.client.protocolSend('open', 't2', { window: 'remote', label: LABEL });
        await settle();
        expect(seen.connections).toHaveLength(2);
        l.windowSide.close();
        await settle();
        expect(seen.closed.sort()).toEqual([0, 1]);
    });

    it('either end closing is told to the other', async () => {
        const tunnels = new ProtocolTunnels();
        const seen = admitted(tunnels);
        const l = await linkTo(tunnels);
        l.client.protocolSend('open', 't1', { window: 'main', label: LABEL });
        l.client.protocolSend('open', 't2', { window: 'main', label: LABEL });
        await settle();
        seen.connections[0]!.close();
        l.client.protocolSend('close', 't2', 'the page went');
        await settle();
        expect(l.events).toContainEqual({ tunnel: 't1', kind: 'closed', reason: expect.any(String) });
        expect(seen.closed.sort()).toEqual([0, 1]);
    });

    it('the 1 MiB frame cap holds both ways: an oversized frame ends that connection, said', async () => {
        const tunnels = new ProtocolTunnels();
        const seen = admitted(tunnels);
        const l = await linkTo(tunnels);
        l.client.protocolSend('open', 't1', { window: 'main', label: LABEL });
        l.client.protocolSend('open', 't2', { window: 'main', label: LABEL });
        await settle();
        const big = JSON.stringify({ kind: 'event', channel: 'x', payload: 'a'.repeat(LOCAL_FRAME_LIMIT_BYTES) });
        seen.connections[0]!.send(big);
        l.client.protocolSend('frame', 't2', big);
        await settle();
        expect(seen.closed.sort()).toEqual([0, 1]);
        expect(seen.heard[1]).toEqual([]);
        const toT1 = l.events.filter((e) => e.tunnel === 't1');
        // The oversized frame never crosses; the window is told why (a refused frame), then the end.
        expect(toT1.filter((e) => e.kind === 'frame').map((e) => JSON.parse((e as { text: string }).text) as unknown)).toEqual([{ kind: 'refused', reason: expect.stringMatching(/1 MiB/) }]);
        expect(toT1.at(-1)).toMatchObject({ kind: 'closed' });
        expect((toT1.at(-1) as { reason: string }).reason).toMatch(/1 MiB/);
    });

    it('the welcome binds the RemoteHost connection to its window process, with that window’s browser pane', async () => {
        const bound: Array<[string, TunnelBinding, FeatureBrowser | null]> = [];
        const unbound: string[] = [];
        const browsers: Array<[string, FeatureBrowser | null]> = [];
        const tunnels = new ProtocolTunnels({ onBound: (id, b, browser) => bound.push([id, b, browser]), onUnbound: (id) => unbound.push(id), onBrowser: (id, b) => browsers.push([id, b]) });
        const seen = admitted(tunnels);
        const l = await linkTo(tunnels);
        const pane: FeatureBrowser = { url: 'https://docs.example.test/', canGoBack: true, canGoForward: false };
        l.client.protocolSend('open', 't1', { window: 'main', label: LABEL });
        l.client.protocolSend('browser', 't1', pane);
        await settle();
        expect(tunnels.bindingOf('rc_1')).toBeNull();
        seen.connections[0]!.send(JSON.stringify({ kind: 'welcome', connectionId: 'rc_1', host: 'box', isOwner: true, workspaceId: null }));
        await settle();
        const binding = tunnels.bindingOf('rc_1');
        expect(binding).toMatchObject({ tunnel: 't1', window: 'main' });
        expect(typeof binding!.owner).toBe('string');
        expect(bound).toEqual([['rc_1', binding, pane]]);
        l.client.protocolSend('browser', 't1', null);
        await settle();
        expect(browsers).toEqual([['rc_1', null]]);
        seen.connections[0]!.close();
        await settle();
        expect(unbound).toEqual(['rc_1']);
        expect(tunnels.bindingOf('rc_1')).toBeNull();
    });

    it('what only a window can do goes to the window process that owns the connection, or with none named to a local one', async () => {
        const tunnels = new ProtocolTunnels();
        const seen = admitted(tunnels);
        const l = await linkTo(tunnels);
        l.client.protocolSend('open', 't1', { window: 'main', label: LABEL });
        await settle();
        seen.connections[0]!.send(JSON.stringify({ kind: 'welcome', connectionId: 'rc_1', host: 'box', isOwner: true, workspaceId: null }));
        await settle();
        const owner = tunnels.bindingOf('rc_1')!.owner;
        await expect(l.server.windowOp(owner, 'gapps.open', ['pkg.notes'])).resolves.toBe('done');
        await expect(l.server.windowOp(null, 'trash', ['/w/shop/old.txt'])).resolves.toBe('done');
        expect(l.ops).toEqual([['gapps.open', ['pkg.notes']], ['trash', ['/w/shop/old.txt']]]);
        await expect(l.server.featureEffect(owner, 'rc_1', 'openExternal', ['https://example.test/'])).resolves.toEqual({ value: 'shown', browser: null });
        expect(l.effects).toEqual([['rc_1', 'openExternal', ['https://example.test/']]]);
    });

    it('CONTROL: with no local window linked, a window operation is refused, not left waiting', async () => {
        const tunnels = new ProtocolTunnels();
        const server = new SessionEngineServer({ token: TOKEN, build: 't', protocol: tunnels });
        await linkTo(tunnels, { local: false, server });
        await expect(server.windowOp(null, 'trash', ['/w/shop/old.txt'])).rejects.toThrow();
        await expect(server.windowOp('no-such-owner', 'gapps.open', ['pkg.notes'])).rejects.toThrow();
    });
});

/** main's IPC door, as a transport the test opens connections on. */
function fakeDoor(): ServerTransport & { connect(preAuth: PreAuth): ClientTransport } {
    const listeners = new Set<(c: ServerConnection) => void>();
    return {
        onConnection: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        connect: (preAuth) => {
            const pair = inMemoryPair();
            for (const l of listeners) l({ ...pair.server, remoteAddress: 'local-window', preAuth });
            return pair.client;
        },
    };
}

function listen(t: ClientTransport) {
    const frames: WireMessage[] = [];
    let closed = false;
    t.onMessage((text) => { const r = parseMessage(text); if (r.ok) frames.push(r.message); });
    t.onClose(() => { closed = true; });
    return { frames, closed: () => closed };
}

/** genie-host's remote host API over a fake registry with one agent: what the window's connection is served. */
function hostApiFixture(over: Partial<HostApiDeps> = {}): HostApi {
    const none = () => () => {};
    return buildHostApi({
        snapshot: () => ({ agents: [], workspaces: [{ id: 'ws_shop', path: '/w/shop', agentsKnown: true }], deckItems: [], signals: {} }),
        subscribeSnapshot: none,
        subscribeAgentRecords: none,
        find: (id: string) => (id === 'agent_kai' ? { id: 'agent_kai', workspaceId: 'ws_shop', provider: 'claude', name: 'kai' } : null),
        detailFor: () => null,
        cwdFor: () => '/w/shop',
        host: { subscribe: none },
        terminals: { onData: none, onExit: none, list: () => [] },
        features: {},
        updates: null,
        workspaceOps: {},
        agentOps: {},
        ...over,
    } as unknown as HostApiDeps);
}

async function hostWith(alone: HostApi, extra?: ServerTransport) {
    const home = await mkdtemp(join(tmpdir(), 'genie-2d4b-'));
    const tunnels = new ProtocolTunnels();
    const hub = transportHub(tunnels);
    if (extra) hub.add(extra);
    const access = await RemoteAccessHost.open({ home, hostName: 'box', api: hostRemoteApi({ hostName: 'box', own: {}, alone, workspaceOfAgent: (id) => (id === 'agent_kai' ? 'ws_shop' : null) }), transport: hub, now: () => 1_000_000 });
    cleanups.push(async () => { await access.close(); await rm(home, { recursive: true, force: true }); });
    const linked = await linkTo(tunnels);
    const door = fakeDoor();
    const bridge = tunnelDoor(door, tunnelLinkOf(linked.client));
    cleanups.push(() => bridge.dispose());
    return { access, tunnels, linked, door, bridge };
}

describe('main forwards its door’s connections over the tunnel (main side)', () => {
    it('this machine’s window says hello to genie-host’s RemoteHost and is welcomed as its own window', async () => {
        const h = await hostWith(hostApiFixture());
        const window = h.door.connect(LOCAL_MAIN);
        const heard = listen(window);
        window.send(JSON.stringify({ kind: 'hello', auth: { kind: 'local' }, label: LABEL }));
        await settle();
        const welcome = heard.frames.find((f) => f.kind === 'welcome') as Extract<WireMessage, { kind: 'welcome' }> | undefined;
        expect(welcome).toMatchObject({ host: 'box', isOwner: true, workspaceId: null });
        expect(h.tunnels.bindingOf(welcome!.connectionId)).toMatchObject({ window: 'main' });
    });

    it('before the engine link is up, the connection is refused as still starting and closed (the page retries)', async () => {
        const door = fakeDoor();
        const bridge = tunnelDoor(door, tunnelLinkOf(new SessionEngineClient()));
        cleanups.push(() => bridge.dispose());
        const window = door.connect(LOCAL_MAIN);
        const heard = listen(window);
        await settle();
        expect(heard.frames).toEqual([{ kind: 'refused', reason: expect.stringMatching(/still starting/) }]);
        expect(heard.closed()).toBe(true);
    });

    it('the engine link going down closes the window’s connection, so the page reconnects to the next host', async () => {
        const h = await hostWith(hostApiFixture());
        const window = h.door.connect(LOCAL_MAIN);
        const heard = listen(window);
        window.send(JSON.stringify({ kind: 'hello', auth: { kind: 'local' }, label: LABEL }));
        await settle();
        expect(heard.closed()).toBe(false);
        h.linked.windowSide.close();
        await settle();
        expect(heard.closed()).toBe(true);
    });

    it('the window closing its connection closes genie-host’s', async () => {
        const tunnels = new ProtocolTunnels();
        const seen = admitted(tunnels);
        const linked = await linkTo(tunnels);
        const door = fakeDoor();
        const bridge = tunnelDoor(door, tunnelLinkOf(linked.client));
        cleanups.push(() => bridge.dispose());
        const window = door.connect(LOCAL_MAIN);
        await settle();
        expect(seen.connections).toHaveLength(1);
        window.close();
        await settle();
        expect(seen.closed).toEqual([0]);
    });

    it('the window’s browser pane is said once its welcome names the connection, and again when it changes', async () => {
        const bound: Array<[string, FeatureBrowser | null]> = [];
        const changed: Array<[string, FeatureBrowser | null]> = [];
        const tunnels = new ProtocolTunnels({ onBound: (id, _b, browser) => bound.push([id, browser]), onBrowser: (id, browser) => changed.push([id, browser]) });
        const seen = admitted(tunnels);
        const linked = await linkTo(tunnels);
        let pane: FeatureBrowser = { url: 'https://a.example.test/', canGoBack: false, canGoForward: false };
        const asked: string[] = [];
        const door = fakeDoor();
        const bridge = tunnelDoor(door, tunnelLinkOf(linked.client), { browser: (id) => { asked.push(id); return pane; } });
        cleanups.push(() => bridge.dispose());
        door.connect(LOCAL_MAIN);
        await settle();
        seen.connections[0]!.send(JSON.stringify({ kind: 'welcome', connectionId: 'rc_7', host: 'box', isOwner: true, workspaceId: null }));
        await settle();
        // genie-host binds at the welcome it sends, before main has seen it; main says the pane as soon as it has.
        expect(asked).toContain('rc_7');
        expect(bound).toEqual([['rc_7', null]]);
        const first = pane;
        expect(changed).toEqual([['rc_7', first]]);
        pane = { url: 'https://b.example.test/', canGoBack: true, canGoForward: false };
        bridge.refreshBrowser();
        await settle();
        expect(changed).toEqual([['rc_7', first], ['rc_7', pane]]);
    });
});

describe('a Pilot’s typing reaches this machine’s window again (Tynn #730)', () => {
    it('the driving Pilot types on genie-host; the window tunnelled to it hears it on its local channel', async () => {
        const relay: Array<(c: ServerConnection) => void> = [];
        const h = await hostWith(hostApiFixture(), { onConnection: (cb) => { relay.push(cb); return () => {}; } });
        // This machine's window, through main's door and the tunnel.
        const window = h.door.connect(LOCAL_MAIN);
        const local = listen(window);
        window.send(JSON.stringify({ kind: 'hello', auth: { kind: 'local' }, label: LABEL }));
        // The Pilot, over the relay, as its owner.
        const pair = inMemoryPair();
        for (const cb of relay) cb({ ...pair.server, remoteAddress: 'relay:Pilot laptop', preAuth: { label: 'Pilot laptop', isOwner: true, workspaceId: null, readonly: false } });
        const pilot = listen(pair.client);
        pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label: 'Pilot laptop' }));
        await settle();
        pair.client.send(JSON.stringify({ kind: 'call', id: 1, method: 'baton.take', args: [] }));
        await settle();
        expect(pilot.frames.find((f) => f.kind === 'result' && f.id === 1)).toMatchObject({ ok: true });
        pair.client.send(JSON.stringify({ kind: 'call', id: 2, method: 'agents.typing', args: ['agent_kai', 'can you see', 'window-pilot'] }));
        await settle();
        expect(pilot.frames.find((f) => f.kind === 'result' && f.id === 2)).toMatchObject({ ok: true });
        const typed = local.frames.filter((f) => f.kind === 'event' && f.channel === LOCAL_EVENTS.typing).map((f) => (f as { payload: unknown }).payload);
        expect(typed).toEqual([{ agentId: 'agent_kai', text: 'can you see', source: 'window-pilot', label: 'Pilot laptop' }]);
    });

    it('CONTROL: with no Pilot typing, the window hears no typing', async () => {
        const h = await hostWith(hostApiFixture());
        const window = h.door.connect(LOCAL_MAIN);
        const local = listen(window);
        window.send(JSON.stringify({ kind: 'hello', auth: { kind: 'local' }, label: LABEL }));
        await settle();
        expect(local.frames.some((f) => f.kind === 'welcome')).toBe(true);
        expect(local.frames.filter((f) => f.kind === 'event' && f.channel === LOCAL_EVENTS.typing)).toEqual([]);
    });
});

const LOCAL_CONTEXT: CallContext = { connectionId: 'rc_1', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: LABEL };

describe('feature effects reach the window that owns the tunnelled connection', () => {
    const pane: FeatureBrowser = { url: 'https://docs.example.test/', canGoBack: false, canGoForward: true };

    it('a bound connection’s effects go to its window process, by the connection genie-host admitted', async () => {
        const calls: Array<[string, string, unknown[]]> = [];
        const callers = new FeatureCallers(() => null);
        callers.bindConnection('rc_1', 'owner_a', async (id, method, args) => { calls.push([id, method, args]); return { value: null, browser: pane }; });
        callers.connectionBrowser('rc_1', pane);
        const ui = callers.presentation(LOCAL_CONTEXT);
        expect(ui).not.toBeNull();
        await ui!.openExternal!('https://example.test/sign-in');
        expect(calls).toEqual([['rc_1', 'openExternal', ['https://example.test/sign-in']]]);
        expect(ui!.browser?.snapshot()).toEqual(pane);
    });

    it('CONTROL: another origin, an unknown connection, an unbound one or a dropped owner presents nothing', () => {
        const callers = new FeatureCallers(() => null);
        callers.bindConnection('rc_1', 'owner_a', async () => ({ value: null, browser: null }));
        expect(callers.presentation({ ...LOCAL_CONTEXT, origin: 'remote-window' })).toBeNull();
        expect(callers.presentation({ ...LOCAL_CONTEXT, connectionId: 'rc_other' })).toBeNull();
        callers.bindConnection('rc_2', 'owner_b', async () => ({ value: null, browser: null }));
        callers.unbindConnection('rc_1');
        expect(callers.presentation(LOCAL_CONTEXT)).toBeNull();
        expect(callers.presentation({ ...LOCAL_CONTEXT, connectionId: 'rc_2' })).not.toBeNull();
        callers.dropOwner('owner_b');
        expect(callers.presentation({ ...LOCAL_CONTEXT, connectionId: 'rc_2' })).toBeNull();
    });
});

describe('window-local operations, done in the window’s process', () => {
    const ws = resolve(tmpdir(), 'genie-2d4b-ws');
    const handler = (log: string[]) => windowOpsHandler({
        trash: async (path) => { log.push(`trash ${path}`); },
        workspaces: () => [{ path: ws }],
        openApp: async (id, preview) => { log.push(`open ${id} ${preview}`); },
    });

    it('the OS trash, for a file inside a registered workspace', async () => {
        const log: string[] = [];
        await handler(log)('trash', [join(ws, 'notes', 'old.txt')]);
        expect(log).toEqual([`trash ${join(ws, 'notes', 'old.txt')}`]);
    });

    it('CONTROL: never a path outside every workspace, the workspace itself, a relative path or a climb out', async () => {
        const log: string[] = [];
        const run = handler(log);
        for (const bad of [resolve(tmpdir(), 'elsewhere', 'x.txt'), ws, 'notes/old.txt', join(ws, '..', 'genie-2d4b-other', 'x.txt'), 42]) {
            await expect(run('trash', [bad])).rejects.toThrow();
        }
        expect(log).toEqual([]);
    });

    it('an app’s window and a preview open in this window’s process', async () => {
        const log: string[] = [];
        const run = handler(log);
        await run('gapps.open', ['pkg.notes']);
        await run('gapps.preview', ['pkg.notes']);
        expect(log).toEqual(['open pkg.notes false', 'open pkg.notes true']);
        await expect(run('something.else', [])).rejects.toThrow();
    });
});

function localPorts(appWindow?: HostLocalSources['appWindow']) {
    const book = { list: async () => [] };
    return hostLocalPorts({
        workspaces: () => [], workspacePath: () => null, files: () => null, plugins: { dump: () => ({ entries: [] }) },
        sendFromPerson: async () => {}, drafts: {}, terminals: () => null, trackCwd: () => false, terminalEnv: () => ({}),
        marketplace: () => null, gapps: () => book, onGappsChanged: () => () => {}, say: () => {},
        ...(appWindow ? { appWindow } : {}),
    } as unknown as HostLocalSources);
}

describe('an app’s window opens in the window that asked', () => {
    it('genie-host’s GApp port hands open and preview, with the caller, to the window', async () => {
        const asked: Array<[CallContext | undefined, string, boolean]> = [];
        const ports = localPorts(async (context, id, preview) => { asked.push([context, id, preview]); });
        await ports.gapps(LOCAL_CONTEXT)!.open('pkg.notes');
        await ports.gapps(LOCAL_CONTEXT)!.preview('pkg.notes');
        expect(asked).toEqual([[LOCAL_CONTEXT, 'pkg.notes', false], [LOCAL_CONTEXT, 'pkg.notes', true]]);
    });

    it('CONTROL: with no window to ask, the words are as before', async () => {
        await expect(localPorts().gapps(LOCAL_CONTEXT)!.open('pkg.notes')).rejects.toThrow(/opens in a Genie window/);
    });

    it('RemoteHost passes the caller it admitted, end to end from the tunnelled window', async () => {
        const asked: Array<[CallContext | undefined, string]> = [];
        const alone = hostApiFixture({ gapps: (context?: CallContext) => ({ list: async () => [], open: async (id: string) => { asked.push([context, id]); }, preview: async () => {} }) } as unknown as Partial<HostApiDeps>);
        const h = await hostWith(alone);
        const window = h.door.connect(LOCAL_MAIN);
        const heard = listen(window);
        window.send(JSON.stringify({ kind: 'hello', auth: { kind: 'local' }, label: LABEL }));
        await settle();
        const welcome = heard.frames.find((f) => f.kind === 'welcome') as { connectionId: string };
        window.send(JSON.stringify({ kind: 'call', id: 5, method: 'gapps.open', args: ['pkg.notes'] }));
        await settle();
        expect(heard.frames.find((f) => f.kind === 'result' && f.id === 5)).toMatchObject({ ok: true });
        expect(asked).toEqual([[expect.objectContaining({ connectionId: welcome.connectionId, origin: 'local-window' }), 'pkg.notes']]);
    });
});

describe('wired: genie-host serves the window, main forwards it', () => {
    it('genie-host adds the tunnels to its remote hub, hands them the engine link, and binds feature effects, apps and the trash', async () => {
        const host = await readFile('src/main/genie-host.ts', 'utf8');
        expect(host).toMatch(/remoteHub\.add\(protocolTunnels\)/);
        expect(host).toMatch(/protocol: protocolTunnels/);
        expect(host).toMatch(/featureCallers\.bindConnection\(/);
        expect(host).toMatch(/appWindow: /);
        expect(host).toMatch(/windowOp\(null, 'trash'/);
    });

    it('main no longer serves its door: it tunnels it, answers window operations and says what changed', async () => {
        const main = await readFile('src/main/main.ts', 'utf8');
        expect(main).not.toMatch(/remoteHub\.add\(localDoor\)/);
        expect(main).toMatch(/tunnelDoor\(localDoor, tunnelLinkOf\(/);
        expect(main).toMatch(/onWindowOp: /);
        expect(main).toMatch(/'engine\.features', \['invalidate'/);
    });
});
