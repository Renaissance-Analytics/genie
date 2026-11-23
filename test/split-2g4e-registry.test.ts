import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { CONTROL_METHODS, LOCAL_EVENTS, REMOTE_METHODS, capabilityOf, inMemoryPair, parseMessage, type RemoteMethod, type ServerTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { OWN_CLIENT_LABEL, ownProtocolClient, type OwnCallAnswer } from '../src/main/own-protocol-client.js';
import { Registry } from '../src/main/registry.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { Store } from '../src/main/store.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4e (Tynn #1007; the last of 2g-4). main's window registry reads and writes genie-host's registry
 * over the one protocol, not over the engine link's store replicas: a local `registry.watch` (heard on `local-registry`
 * whenever the registry's files are written) and `registry.read`, both controls only main's own client may say, and a
 * local `registry.write` only main's own client may call. main's own client is tunnelled before the registry loads, so
 * the Genie 1 import writes through genie-host. The engine-use scanner follows aliases of the engine client, so a use
 * through `engineLink` is listed like any other; `stores` leaves the list with compose's input (2g-4d, Tynn #955).
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Dynamic: the modules are new in this step, so each case goes red on its own rather than the file failing to load. */
type Refusal = { ok: false; reason: string };
type RegistryProtocol = {
    REGISTRY_READS: readonly string[];
    REGISTRY_WRITES: readonly string[];
    EMPTY_REGISTRY_WATCH: { revision: number; dropped: readonly string[] };
    readRegistryRead(args: unknown[]): string | Refusal;
    readRegistryWrite(args: unknown[]): { method: string; args: unknown[] } | Refusal;
    readRegistryWatch(raw: unknown): { revision: number; dropped: readonly string[] };
    registryWatchFeed(ports: { dropped(): readonly string[]; onWritten(listener: () => void): () => void }): { now(): { revision: number; dropped: readonly string[] }; subscribe(listener: (view: { revision: number; dropped: readonly string[] }) => void): () => void };
};
type WindowRegistryStore = {
    openWindowRegistryStore(own: { call(method: string, args: unknown[]): Promise<OwnCallAnswer> }): Promise<import('../src/main/registry.js').RegistryStore>;
    registryChanges(own: { watchRegistry(onView: (view: unknown) => void): () => void }): { onRegistryChanged(listener: () => void): () => void };
};
const protocol = async (): Promise<RegistryProtocol> => { const file: string = '../src/main/registry-protocol.js'; return (await import(file)) as RegistryProtocol; };
const windowStore = async (): Promise<WindowRegistryStore> => { const file: string = '../src/main/window-registry-store.js'; return (await import(file)) as WindowRegistryStore; };

const READ = 'registry.read';
const WATCH = 'registry.watch';
const WRITE = 'registry.write' as RemoteMethod;
const WS = { id: 'ws_a', path: '/work/a' };

describe('the protocol: registry.watch and registry.read, controls; registry.write, a local method', () => {
    it('the two controls and their event; the write is local and genie-host’s own', () => {
        expect(CONTROL_METHODS as readonly string[]).toContain(WATCH);
        expect(CONTROL_METHODS as readonly string[]).toContain(READ);
        expect((LOCAL_EVENTS as Record<string, string>).registry).toBe('local-registry');
        expect(REMOTE_METHODS as readonly string[]).toContain(WRITE);
        expect(capabilityOf(WRITE)).toBe('local');
        expect(HOST_ALONE_METHODS.has(WRITE)).toBe(true);
    });

    it('a read names one of the registry’s reads, alone; anything else is refused', async () => {
        const p = await protocol();
        expect([...p.REGISTRY_READS].sort()).toEqual(['dropped', 'readAgents', 'readInterruptedAtQuit', 'readRunningAtQuit', 'readWorkspaces']);
        for (const m of p.REGISTRY_READS) expect(p.readRegistryRead([m])).toBe(m);
        for (const bad of [[], ['writeAgents'], ['__proto__'], ['constructor'], [7], ['readAgents', 'more']]) expect(p.readRegistryRead(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    });

    it('a write is one of the registry’s writes with its own arguments, read strictly; anything else is refused', async () => {
        const p = await protocol();
        expect([...p.REGISTRY_WRITES].sort()).toEqual(['beginRestore', 'restoreStarted', 'writeAgents', 'writeInterruptedAtQuit', 'writeRunningAtQuit', 'writeWorkspaces']);
        expect(p.readRegistryWrite(['writeWorkspaces', [[WS]]])).toEqual({ method: 'writeWorkspaces', args: [[WS]] });
        expect(p.readRegistryWrite(['writeAgents', [[]]])).toEqual({ method: 'writeAgents', args: [[]] });
        expect(p.readRegistryWrite(['writeRunningAtQuit', [['a1']]])).toEqual({ method: 'writeRunningAtQuit', args: [['a1']] });
        expect(p.readRegistryWrite(['writeInterruptedAtQuit', [[]]])).toEqual({ method: 'writeInterruptedAtQuit', args: [[]] });
        expect(p.readRegistryWrite(['beginRestore', []])).toEqual({ method: 'beginRestore', args: [] });
        expect(p.readRegistryWrite(['restoreStarted', ['a1']])).toEqual({ method: 'restoreStarted', args: ['a1'] });
        for (const bad of [
            [], ['writeAgents'], ['readAgents', []], ['__proto__', []], ['nope', []],
            ['writeWorkspaces', [7]], ['writeWorkspaces', [[7]]], ['writeAgents', [{}]], ['writeAgents', [[null]]],
            ['writeRunningAtQuit', [[7]]], ['writeInterruptedAtQuit', ['a1']],
            ['beginRestore', [1]], ['restoreStarted', [7]], ['restoreStarted', []], ['writeAgents', [[], 'more']],
        ]) expect(p.readRegistryWrite(bad as unknown[]), JSON.stringify(bad)).toMatchObject({ ok: false });
    });

    it('the watch reads what genie-host said; anything that does not read is revision 0, nothing dropped', async () => {
        const p = await protocol();
        expect(p.readRegistryWatch({ revision: 3, dropped: ['agents.json: row 2'] })).toEqual({ revision: 3, dropped: ['agents.json: row 2'] });
        for (const bad of [null, 7, 'x', { revision: 'x' }, { revision: 1, dropped: 'x' }, { revision: 1, dropped: [7] }]) expect(p.readRegistryWatch(bad), JSON.stringify(bad)).toEqual(p.EMPTY_REGISTRY_WATCH);
        expect(p.EMPTY_REGISTRY_WATCH).toEqual({ revision: 0, dropped: [] });
    });

    it('the feed says revision 0 now, then a new revision with each write', async () => {
        const p = await protocol();
        let poke = () => {};
        const feed = p.registryWatchFeed({ dropped: () => ['x'], onWritten: (l) => { poke = l; return () => {}; } });
        expect(feed.now()).toEqual({ revision: 0, dropped: ['x'] });
        const heard: unknown[] = [];
        feed.subscribe((v) => heard.push(v));
        poke(); poke();
        expect(heard).toEqual([{ revision: 1, dropped: ['x'] }, { revision: 2, dropped: ['x'] }]);
        expect(feed.now().revision).toBe(2);
    });
});

describe('genie-host says registry.watch and registry.read to main’s own client, and to nobody else', () => {
    async function host(api: HostApi, transport: ServerTransport) {
        const home = await mkdtemp(join(tmpdir(), 'genie-2g4e-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing, transport });
        return { done: async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); } };
    }
    function api() {
        let emit: (channel: string, payload: unknown) => void = () => {};
        const registryRead = vi.fn(async (method: string) => (method === 'readWorkspaces' ? [WS] : []));
        const a = {
            invoke: vi.fn(async () => null),
            onEvent: (listener: (channel: string, payload: unknown) => void) => { emit = listener; return () => {}; },
            workspaceOfAgent: () => null,
            registryWatch: () => ({ revision: 0, dropped: [] }),
            registryRead,
        } as unknown as HostApi;
        return { api: a, registryRead, emit: (channel: string, payload: unknown) => emit(channel, payload) };
    }
    const connector = () => {
        let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void = () => {};
        const transport: ServerTransport = { onConnection: (l) => { accept = l; return () => {}; } };
        const connect = async (preAuth: Record<string, unknown>) => {
            const pair = inMemoryPair();
            const frames: WireMessage[] = [];
            pair.client.onMessage((m) => { const r = parseMessage(m); if (r.ok) frames.push(r.message); });
            accept({ ...pair.server, preAuth: preAuth as never });
            pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: preAuth.kind }, label: String(preAuth.label) }));
            await settle();
            const call = async (id: number, method: string, args: unknown[] = []) => {
                pair.client.send(JSON.stringify({ kind: 'call', id, method, args }));
                await settle();
                return frames.find((m) => m.kind === 'result' && m.id === id) as Extract<WireMessage, { kind: 'result' }> | undefined;
            };
            return { call, events: () => frames.filter((m) => m.kind === 'event') as Extract<WireMessage, { kind: 'event' }>[] };
        };
        return { transport, connect };
    };
    const OWN = { kind: 'local', label: OWN_CLIENT_LABEL, isOwner: true, workspaceId: null, readonly: false, window: 'main', own: true };
    const PAGE = { kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false, window: 'main' };
    const TRAY_LABEL_ONLY = { ...PAGE, label: OWN_CLIENT_LABEL };
    const RELAY = { kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false };

    it.each([[WATCH, []], [READ, ['readWorkspaces']]] as const)('%s: a page in this machine’s window, one only labelled Genie’s tray, or another machine is refused; main’s own client is answered', async (method, args) => {
        const a = api();
        const c = connector();
        const h = await host(a.api, c.transport);
        try {
            for (const preAuth of [PAGE, TRAY_LABEL_ONLY, RELAY]) {
                const other = await c.connect(preAuth);
                expect(await other.call(1, method, [...args]), `${method} ${JSON.stringify(preAuth)}`).toMatchObject({ ok: false });
            }
            expect(a.registryRead).not.toHaveBeenCalled();
            // CONTROL: main's own client is answered.
            const own = await c.connect(OWN);
            expect(await own.call(1, method, [...args])).toMatchObject({ ok: true });
        } finally { await h.done(); }
    });

    it('registry.read answers the host’s read; a read it does not know is refused, never asked', async () => {
        const a = api();
        const c = connector();
        const h = await host(a.api, c.transport);
        try {
            const own = await c.connect(OWN);
            expect(await own.call(1, READ, ['readWorkspaces'])).toMatchObject({ ok: true, value: [WS] });
            expect(a.registryRead).toHaveBeenCalledWith('readWorkspaces');
            expect(await own.call(2, READ, ['writeWorkspaces'])).toMatchObject({ ok: false });
            expect(await own.call(3, READ, [])).toMatchObject({ ok: false });
            expect(a.registryRead).toHaveBeenCalledTimes(1);
        } finally { await h.done(); }
    });

    it('main’s own registry watcher hears local-registry and nothing else; no other connection hears it', async () => {
        const a = api();
        const c = connector();
        const h = await host(a.api, c.transport);
        try {
            const own = await c.connect(OWN);
            expect(await own.call(1, WATCH)).toMatchObject({ ok: true, value: { revision: 0, dropped: [] } });
            const page = await c.connect(PAGE);
            a.emit('local-registry', { revision: 1, dropped: [] });
            a.emit('local-features', { revision: 2 });
            await settle();
            expect(own.events().map((e) => [e.channel, e.payload])).toEqual([['local-registry', { revision: 1, dropped: [] }]]);
            // CONTROL: the page hears what it always heard.
            expect(page.events().map((e) => e.channel)).toContain('local-features');
            expect(page.events().map((e) => e.channel)).not.toContain('local-registry');
        } finally { await h.done(); }
    });
});

describe('genie-host’s host API: registry.write from main’s own client only; the reads and the watch beside it', () => {
    const base = { connectionId: 'c1', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: OWN_CLIENT_LABEL } as const;
    const deps = (registryFiles?: { call(method: string, args: unknown[]): Promise<unknown>; dropped(): readonly string[] }) =>
        ({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, ...(registryFiles ? { registryFiles } : {}) }) as unknown as HostApiDeps;

    it('main’s own client writes through the host’s registry; a page in the window is refused and the registry never written', async () => {
        const call = vi.fn(async () => undefined);
        const api = buildHostApi(deps({ call, dropped: () => [] }));
        expect(await api.invoke(WRITE, ['writeWorkspaces', [[WS]]], { ...base, own: true })).toBeUndefined();
        expect(call).toHaveBeenCalledWith('writeWorkspaces', [[WS]]);
        expect(await api.invoke(WRITE, ['writeWorkspaces', [[WS]]], base)).toMatchObject({ ok: false });
        expect(await api.invoke(WRITE, ['nope', []], { ...base, own: true })).toMatchObject({ ok: false });
        expect(call).toHaveBeenCalledTimes(1);
        // CONTROL: a host with no registry says so.
        expect(await buildHostApi(deps()).invoke(WRITE, ['writeWorkspaces', [[WS]]], { ...base, own: true })).toMatchObject({ ok: false });
    });

    it('its reads go to the host’s registry, what it dropped from the store', async () => {
        const call = vi.fn(async (method: string) => (method === 'readAgents' ? [{ id: 'a1' }] : []));
        const api = buildHostApi(deps({ call, dropped: () => ['agents.json: row 2'] })) as HostApi & { registryRead?(method: string): Promise<unknown> };
        expect(await api.registryRead!('readAgents')).toEqual([{ id: 'a1' }]);
        expect(call).toHaveBeenCalledWith('readAgents', []);
        expect(await api.registryRead!('dropped')).toEqual(['agents.json: row 2']);
    });
});

describe('main’s side: a registry store over its own client', () => {
    function own(answers: Record<string, unknown> = {}) {
        const calls: Array<[string, unknown[]]> = [];
        let refuse: string | null = null;
        return {
            calls,
            refuse: (reason: string) => { refuse = reason; },
            client: {
                call: async (method: string, args: unknown[]): Promise<OwnCallAnswer> => {
                    calls.push([method, args]);
                    if (refuse) return { ok: false, reason: refuse };
                    const key = String(args[0]);
                    return { ok: true, value: key in answers ? answers[key] : (method === READ ? [] : undefined) };
                },
            },
        };
    }

    it('opens by reading what the host dropped; reads are registry.read, writes registry.write', async () => {
        const w = await windowStore();
        const o = own({ dropped: ['agents.json: row 2'], readWorkspaces: [WS], restoreStarted: true, beginRestore: { running: ['a1'], interrupted: [] } });
        const store = await w.openWindowRegistryStore(o.client);
        expect(store.dropped).toEqual(['agents.json: row 2']);
        expect(await store.readWorkspaces()).toEqual([WS]);
        await store.writeWorkspaces([WS] as never);
        await store.writeAgents([]);
        await store.writeRunningAtQuit(['a1']);
        await store.writeInterruptedAtQuit([]);
        expect(await store.beginRestore()).toEqual({ running: ['a1'], interrupted: [] });
        expect(await store.restoreStarted('a1')).toBe(true);
        expect(o.calls).toEqual([
            [READ, ['dropped']], [READ, ['readWorkspaces']],
            [WRITE, ['writeWorkspaces', [[WS]]]], [WRITE, ['writeAgents', [[]]]], [WRITE, ['writeRunningAtQuit', [['a1']]]], [WRITE, ['writeInterruptedAtQuit', [[]]]],
            [WRITE, ['beginRestore', []]], [WRITE, ['restoreStarted', ['a1']]],
        ]);
    });

    it('a refusal throws its words, as the store’s own failure would; a read that does not read as a list throws too', async () => {
        const w = await windowStore();
        const o = own({ readAgents: 'not a list' });
        const store = await w.openWindowRegistryStore(o.client);
        await expect(store.readAgents()).rejects.toThrow(/registry/);
        const refused = own({ readWorkspaces: { ok: false, reason: 'this host keeps no registry' } });
        const s2 = await w.openWindowRegistryStore(refused.client);
        await expect(s2.readWorkspaces()).rejects.toThrow('this host keeps no registry');
        refused.refuse('Genie is still starting');
        await expect(s2.writeAgents([])).rejects.toThrow('Genie is still starting');
        await expect(w.openWindowRegistryStore(refused.client)).rejects.toThrow('Genie is still starting');
    });

    it('every view the watch says (its answer, each reconnect, each write) is a change to re-read', async () => {
        const w = await windowStore();
        let say: (view: unknown) => void = () => {};
        const stop = vi.fn();
        const changes = w.registryChanges({ watchRegistry: (l) => { say = l; return stop; } });
        let heard = 0;
        const off = changes.onRegistryChanged(() => { heard += 1; });
        say({ revision: 0, dropped: [] }); say({ revision: 1, dropped: [] });
        expect(heard).toBe(2);
        off();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('END TO END: a window Registry over main’s own client, through RemoteHost and genie-host’s API, writes genie-host’s files; another write is heard', async () => {
        const w = await windowStore();
        const p = await protocol();
        const home = await mkdtemp(join(tmpdir(), 'genie-2g4e-files-'));
        const devHome = await mkdtemp(join(tmpdir(), 'genie-2g4e-dev-'));
        const devices = await DeviceStore.open(devHome, { now: Date.now, random: () => 'tok' });
        try {
            const files = new Store(home);
            let written = () => {};
            const feed = p.registryWatchFeed({ dropped: () => files.dropped, onWritten: (l) => { written = l; return () => {}; } });
            const call = async (method: string, args: unknown[]) => {
                const out = await (files as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
                if (method.startsWith('write')) written();
                return out;
            };
            const built = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, registryFiles: { call, dropped: () => files.dropped }, registryWatch: feed } as unknown as HostApiDeps) as HostApi & { registryRead?(m: string): Promise<unknown>; registryWatch?(): unknown };
            let emit: (channel: string, payload: unknown) => void = () => {};
            feed.subscribe((view) => emit(LOCAL_EVENTS.registry, view));
            const api = {
                invoke: (m: RemoteMethod, a: unknown[], c: never) => built.invoke(m, a, c),
                onEvent: (l: typeof emit) => { emit = l; return () => {}; },
                workspaceOfAgent: () => null,
                registryRead: (m: string) => built.registryRead!(m),
                registryWatch: () => built.registryWatch!(),
            } as unknown as HostApi;
            const client = ownProtocolClient() as ReturnType<typeof ownProtocolClient> & { watchRegistry(onView: (view: unknown) => void): () => void };
            new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.4 }), confirm: allowEveryPairing, transport: client.door });
            const registry = new Registry(await w.openWindowRegistryStore(client as never));
            const views: unknown[] = [];
            const stop = client.watchRegistry((v) => views.push(v));
            await registry.load({ name: 'alphar', healthy: true });
            await registry.addWorkspace(WS);
            expect((await files.readWorkspaces()).map((x) => x.id)).toContain('ws_a');
            await settle();
            expect(views.length).toBeGreaterThan(1);
            stop();
        } finally { await devices.flushed(); await rm(home, { recursive: true, force: true }); await rm(devHome, { recursive: true, force: true }); }
    });
});

describe('wired: main’s registry is genie-host’s over the protocol, the engine link’s stores untouched', () => {
    const main = code(src('src/main/main.ts'));

    it('main’s registry reads and writes over its own client, and re-reads on the watch', () => {
        expect(main).toMatch(/theRegistry\.useStore\(await openWindowRegistryStore\(ownProtocol\)\);/);
        expect(main).toMatch(/watchRegistryRefresh\(registryChanges\(ownProtocol\), theRegistry, /);
        expect(main).not.toMatch(/HostRegistryStore/);
        expect(main).not.toMatch(/engineLink\??\.stores\(/);
    });

    it('main’s own client is tunnelled once, before the registry loads, so the Genie 1 import writes through genie-host', () => {
        const tunnels = [...main.matchAll(/tunnelDoor\(ownProtocol\.door, /g)];
        expect(tunnels).toHaveLength(1);
        const at = (needle: string) => { const i = main.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
        expect(at('tunnelDoor(ownProtocol.door, ')).toBeLessThan(at('theRegistry.useStore(await openWindowRegistryStore(ownProtocol));'));
        expect(at('theRegistry.useStore(await openWindowRegistryStore(ownProtocol));')).toBeLessThan(at('await registry.load({ name: hostname(), healthy: true });'));
        expect(at('await registry.load({ name: hostname(), healthy: true });')).toBeLessThan(at('await importFromV1(theRegistry);'));
    });

    it('the host tools go to genie-host by the one member they use, never the whole engine client', () => {
        expect(main).toMatch(/withHostTools\(signalled, \{ runHostTool: \(call\) => engineLink\.runHostTool\(call\) \}, resolveCaller\)/);
        expect(code(src('src/main/window-tools.ts'))).toMatch(/host: \{ runHostTool\(call: ForwardedToolCall\): Promise<McpToolResult> \}/);
    });

    it('genie-host feeds registry.watch from its store’s writes, and its host API says it on local-registry', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/const registryWatch = registryWatchFeed\(\{ dropped: \(\) => registryStore\.dropped, onWritten: \(listener\) => stores\.onEvent\(\(event\) => \{ if \(event\.store === 'registry'\) listener\(\); \}\) \}\);/);
        expect(host).toMatch(/registryFiles: \{ call: \(method, args\) => stores\.call\('registry', method, args\), dropped: \(\) => registryStore\.dropped \},/);
        expect(code(src('src/main/host-api.ts'))).toMatch(/deps\.registryWatch\?\.subscribe\(\(view\) => listener\(LOCAL_EVENTS\.registry, view\)\)/);
    });
});
