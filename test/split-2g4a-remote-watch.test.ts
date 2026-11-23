import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { CONTROL_METHODS, LOCAL_EVENTS, inMemoryPair, parseMessage, type RemoteMethod, type ServerTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { EMPTY_REMOTE_WATCH, readRemoteWatch, remoteWatchFeed, type RemoteWatchView } from '../src/core/remote-watch.js';
import { hostDraftPrune } from '../src/main/host-draft-prune.js';
import { OWN_CLIENT_LABEL, ownProtocolClient } from '../src/main/own-protocol-client.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4a (Tynn #997; part of #955, the coordinator's approved split). main's desktop notifications for
 * remote access (a share-link guest asking to come in, someone connecting) read genie-host over the one protocol: a
 * local-only `remote.watch` that only main's own client may say (`own`, as keychain.adoptLegacy), heard on `local-remote`.
 * main keeps no remote-access replica (`client.remoteAccess()`), and the chat drafts are pruned in genie-host, which keeps
 * them and the registry. The remoteAccess row leaves the engine inventory.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const WATCH = 'remote.watch' as RemoteMethod;

const GUEST = { id: 'pr_1', label: 'wren’s phone', from: '100.64.0.9', host: 'alphar', replaces: null, raisedAt: 1_000, expiresAt: 121_000, guest: { workspace: 'tynn', readonly: false } };
const VIEW: RemoteWatchView = { hostName: 'alphar', connections: [{ id: 'conn_9', label: 'laptop', driving: false, mode: 'control' }], pairRequests: [GUEST] };

describe('the protocol: remote.watch, heard on local-remote', () => {
    it('is a control method with its own local event', () => {
        expect(CONTROL_METHODS as readonly string[]).toContain('remote.watch');
        expect((LOCAL_EVENTS as Record<string, string>).remote).toBe('local-remote');
    });

    it('reads what genie-host said, and anything that does not read is nobody (fail closed)', () => {
        expect(readRemoteWatch(VIEW)).toEqual(VIEW);
        for (const bad of [null, 7, 'x', { hostName: 3 }, { connections: 'all' }]) expect(readRemoteWatch(bad), JSON.stringify(bad)).toEqual(EMPTY_REMOTE_WATCH);
        // A row that does not read is dropped, the rest kept.
        expect(readRemoteWatch({ hostName: 'alphar', connections: [{ id: 1 }, VIEW.connections[0]], pairRequests: [{ id: 'x' }, GUEST] })).toEqual(VIEW);
    });

    it('the feed says a view only when it changed', () => {
        let now: RemoteWatchView = VIEW;
        let poke = () => {};
        const feed = remoteWatchFeed({ read: () => now, onChange: (l) => { poke = l; return () => {}; } });
        const heard: RemoteWatchView[] = [];
        feed.subscribe((v) => heard.push(v));
        poke();
        expect(heard).toEqual([]);
        now = { ...VIEW, pairRequests: [] };
        poke();
        expect(heard).toEqual([now]);
        expect(feed.now()).toEqual(now);
    });
});

describe('genie-host says it to main’s own client, and to nobody else', () => {
    async function host(api: HostApi, transport: ServerTransport) {
        const home = await mkdtemp(join(tmpdir(), 'genie-2g4a-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        const remote = new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing, transport });
        return { remote, done: async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); } };
    }
    function api() {
        let emit: (channel: string, payload: unknown) => void = () => {};
        const a = {
            invoke: vi.fn(async () => null),
            onEvent: (listener: (channel: string, payload: unknown) => void) => { emit = listener; return () => {}; },
            workspaceOfAgent: () => null,
            remoteWatch: () => VIEW,
        } as unknown as HostApi;
        return { api: a, emit: (channel: string, payload: unknown) => emit(channel, payload) };
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
            const call = async (id: number, method: RemoteMethod, args: unknown[] = []) => {
                pair.client.send(JSON.stringify({ kind: 'call', id, method, args }));
                await settle();
                return frames.find((m) => m.kind === 'result' && m.id === id) as Extract<WireMessage, { kind: 'result' }> | undefined;
            };
            return { frames, call, events: () => frames.filter((m) => m.kind === 'event') as Extract<WireMessage, { kind: 'event' }>[] };
        };
        return { transport, connect };
    };
    const OWN = { kind: 'local', label: OWN_CLIENT_LABEL, isOwner: true, workspaceId: null, readonly: false, window: 'main', own: true };

    it('main’s own client hears the view at once, then each change on local-remote, and nothing else of the host', async () => {
        const a = api();
        const c = connector();
        const h = await host(a.api, c.transport);
        try {
            const own = await c.connect(OWN);
            expect(await own.call(1, WATCH)).toMatchObject({ ok: true, value: VIEW });
            const page = await c.connect({ kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false, window: 'main' });
            const changed = { ...VIEW, pairRequests: [] };
            a.emit('local-remote', changed);
            a.emit('local-summary', { terminals: [] });
            a.emit('local-features', { revision: 3 });
            await settle();
            expect(own.events().map((e) => [e.channel, e.payload])).toEqual([['local-remote', changed]]);
            // CONTROL: the same push reaches an ordinary local window as its own channel, and never local-remote.
            expect(page.events().map((e) => e.channel)).toContain('local-features');
            expect(page.events().map((e) => e.channel)).not.toContain('local-remote');
        } finally { await h.done(); }
    });

    it('a page in this machine’s window, labelled Genie’s tray or not, is refused; so is another machine', async () => {
        const a = api();
        const c = connector();
        const h = await host(a.api, c.transport);
        try {
            for (const preAuth of [
                { kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false, window: 'main' },
                { kind: 'local', label: OWN_CLIENT_LABEL, isOwner: true, workspaceId: null, readonly: false, window: 'main' },
                { kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false },
            ]) {
                const other = await c.connect(preAuth);
                const answer = await other.call(1, WATCH);
                expect(answer, JSON.stringify(preAuth)).toMatchObject({ ok: false });
                expect(JSON.stringify(answer)).not.toContain('wren');
            }
        } finally { await h.done(); }
    });

    it('main’s own client keeps the watch: the first view, then each change', async () => {
        const a = api();
        const own = ownProtocolClient();
        const h = await host(a.api, own.door);
        try {
            const heard: RemoteWatchView[] = [];
            const stop = own.watchRemote((v) => heard.push(v));
            await settle();
            const changed = { ...VIEW, connections: [] };
            a.emit('local-remote', changed);
            await settle();
            expect(heard).toEqual([VIEW, changed]);
            stop();
        } finally { await h.done(); }
    });
});

describe('the drafts are pruned in genie-host', () => {
    function rig(ids: string[]) {
        const pruned: string[][] = [];
        let written = () => {};
        const lines: string[] = [];
        const ports = {
            agents: () => ids,
            drafts: { prune: async (agentIds: Iterable<string>) => { pruned.push([...agentIds]); } },
            onRegistryWritten: (l: () => void) => { written = l; return () => {}; },
            log: (line: string) => lines.push(line),
        };
        return { ports, pruned, write: () => written(), lines, ids };
    }

    it('at boot over the loaded roster, then on a registry write that changed it, and not on one that did not', async () => {
        const r = rig(['a1', 'a2']);
        await hostDraftPrune(r.ports);
        expect(r.pruned).toEqual([['a1', 'a2']]);
        r.write();
        await settle();
        expect(r.pruned).toHaveLength(1);
        r.ids.splice(1, 1);
        r.write();
        await settle();
        expect(r.pruned).toEqual([['a1', 'a2'], ['a1']]);
    });

    it('a prune that fails is said in the log and tried again on the next write', async () => {
        const r = rig(['a1']);
        let fail = true;
        r.ports.drafts.prune = async (agentIds) => { if (fail) throw new Error('disk full'); r.pruned.push([...agentIds]); };
        await hostDraftPrune(r.ports);
        expect(r.lines.join('\n')).toMatch(/drafts could not be pruned: disk full/);
        fail = false;
        r.write();
        await settle();
        expect(r.pruned).toEqual([['a1']]);
    });
});

describe('wired: genie-host says the watch and prunes; main reads the watch and keeps no replica', () => {
    it('genie-host feeds remote.watch from its remote access and prunes the drafts on its registry’s writes', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/remoteWatchFeed\(\{/);
        expect(host).toMatch(/remoteWatch,/);
        expect(host).toMatch(/hostDraftPrune\(\{/);
        const api = code(src('src/main/host-api.ts'));
        expect(api).toMatch(/deps\.remoteWatch\?\.subscribe\(\(view\) => listener\(LOCAL_EVENTS\.remote, view\)\)/);
    });

    it('main’s notifications read the watch; it holds no remote-access replica and prunes no drafts', () => {
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/ownProtocol\.watchRemote\(/);
        expect(main).not.toMatch(/client\??\.remoteAccess\(|linkedRemote|composed\.(remote|pairing)\b/);
        expect(main).not.toMatch(/rosterPruner|stores\(\)\.drafts|draftPruner/);
        // CONTROL: the same scan finds what main still has.
        expect(main).toMatch(/ownProtocol\.watchSummary\(/);
    });

    it('the window’s engine inventory has no remoteAccess row', () => {
        const rows = WINDOW_ENGINE_INVENTORY.filter(([, d]) => d === 'move:2g').map(([u]) => u).sort();
        // 2g-4e (#1007): the scanner follows main's aliases of the engine client, and the uses it found joined the list
        // (tasks on #955 and G-1 #934); the rows are exactly these.
        expect(rows).toEqual(['filesUnwatch', 'filesWatch', 'flows', 'hosting', 'issueWatch', 'onFilesEvent', 'onSpawnFrame', 'onTynnBoardEvent', 'onTynnFeaturesEvent', 'onTynnIssuesEvent', 'runHostTool', 'spawnLink', 'stores', 'supervisor', 'tynnBoardUnwatch', 'tynnBoardWatch', 'tynnFeaturesUnwatch', 'tynnFeaturesWatch', 'tynnIssuesUnwatch', 'tynnIssuesWatch']);
        expect(rows).not.toContain('remoteAccess');
    });
});
