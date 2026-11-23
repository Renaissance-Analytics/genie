import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { CONTROL_METHODS, LOCAL_EVENTS, inMemoryPair, parseMessage, type ServerTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { OWN_CLIENT_LABEL, ownProtocolClient } from '../src/main/own-protocol-client.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4d-D1 (Tynn #1046, task #1495; with #1010). main reads genie-host's front door (its port, Genie's
 * CA, the routes and which workspace each site is in) from an own-only `frontdoor.watch`, heard on `local-frontdoor` when
 * it changes, as `summary.watch`: never from compose's hosting replica. genie-host answers it from its start (hostRemoteApi),
 * as it answers the registry. And genie-host's estate is touched when its front door changes, so the Deck's Trust item
 * reaches deck.watch and the phones (#1010: features were told; the Deck was not).
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

type View = { port: number; caPem: string | null; caReason: string | null; routes: readonly { host: string; target: string }[]; sites: readonly { host: string; name: string; workspaceId: string }[] };
type FrontDoorWatch = {
    EMPTY_FRONT_DOOR_WATCH: View;
    readFrontDoorWatch(raw: unknown): View;
    frontDoorViewOf(stack: { frontDoorPort: number; browserTrust(): { caPem: string; thumbprint?: string } | { caPem: null; reason: string }; routes(): readonly { host: string; target: string }[]; sites: { list(): readonly { host: string; name: string; workspaceId: string }[] } } | null): View;
    frontDoorWatchFeed(ports: { read(): View; onChange(listener: () => void): () => void }): { now(): View; subscribe(listener: (view: View) => void): () => void };
};
type WindowFrontDoor = {
    windowFrontDoor(own: { watchFrontDoor(onView: (view: View) => void): () => void }): { start(): void; ready(deadlineMs: number): Promise<void>; now(): View; onChange(listener: (view: View, moved: boolean) => void): () => void };
};
/** Dynamic: the modules are new in this step, so each case goes red on its own rather than the file failing to load. */
const watchModule = async (): Promise<FrontDoorWatch> => { const file: string = '../src/core/front-door-watch.js'; return (await import(file)) as FrontDoorWatch; };
const windowModule = async (): Promise<WindowFrontDoor> => { const file: string = '../src/main/window-front-door.js'; return (await import(file)) as WindowFrontDoor; };

const WATCH = 'frontdoor.watch';
const VIEW: View = { port: 8443, caPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----', caReason: null, routes: [{ host: 'tynn.gen', target: '127.0.0.1:50311' }], sites: [{ host: 'tynn.gen', name: 'tynn', workspaceId: 'ws_a' }] };

describe('the protocol: frontdoor.watch, heard on local-frontdoor', () => {
    it('is a control method with its own local event', () => {
        expect(CONTROL_METHODS as readonly string[]).toContain(WATCH);
        expect((LOCAL_EVENTS as Record<string, string>).frontdoor).toBe('local-frontdoor');
    });

    it('reads what genie-host said; anything that does not read is no front door yet (port 0, no CA, the reason said)', async () => {
        const w = await watchModule();
        expect(w.readFrontDoorWatch(VIEW)).toEqual(VIEW);
        expect(w.EMPTY_FRONT_DOOR_WATCH).toMatchObject({ port: 0, caPem: null, routes: [], sites: [] });
        expect(w.EMPTY_FRONT_DOOR_WATCH.caReason).toEqual(expect.any(String));
        for (const bad of [null, 7, 'x', { ...VIEW, port: 'x' }, { ...VIEW, caPem: 7 }, { ...VIEW, routes: [{ host: 7, target: 'x' }] }, { ...VIEW, routes: 'x' }, { ...VIEW, sites: [{ host: 'a', workspaceId: 'w' }] }])
            expect(w.readFrontDoorWatch(bad), JSON.stringify(bad).slice(0, 80)).toEqual(w.EMPTY_FRONT_DOOR_WATCH);
    });

    it('the view of genie-host’s hosting: its port, its CA (or why none), its routes, and each site’s workspace; no hosting is no front door', async () => {
        const w = await watchModule();
        const stack = { frontDoorPort: 8443, browserTrust: () => ({ caPem: VIEW.caPem!, thumbprint: 'ab' }), routes: () => VIEW.routes, sites: { list: () => [{ ...VIEW.sites[0]!, id: 's1', port: 50311 }] } };
        expect(w.frontDoorViewOf(stack)).toEqual(VIEW);
        const noCa = { ...stack, browserTrust: () => ({ caPem: null, reason: 'the gen CA is not trusted' }) };
        expect(w.frontDoorViewOf(noCa)).toMatchObject({ caPem: null, caReason: 'the gen CA is not trusted' });
        expect(w.frontDoorViewOf(null)).toMatchObject({ port: 0, caPem: null, routes: [], sites: [] });
    });

    it('the feed says the view now, then again only when it changed', async () => {
        const w = await watchModule();
        let view = VIEW;
        let poke = () => {};
        const feed = w.frontDoorWatchFeed({ read: () => view, onChange: (l) => { poke = l; return () => {}; } });
        expect(feed.now()).toEqual(VIEW);
        const heard: View[] = [];
        feed.subscribe((v) => heard.push(v));
        poke();
        expect(heard).toEqual([]);
        view = { ...VIEW, port: 9443 };
        poke(); poke();
        expect(heard).toEqual([view]);
    });
});

describe('genie-host says frontdoor.watch to main’s own client, and to nobody else, from its start', () => {
    async function host(api: HostApi, transport: ServerTransport) {
        const home = await mkdtemp(join(tmpdir(), 'genie-2g4d-d1-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing, transport });
        return { done: async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); } };
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
    /** As genie-host builds it: hostRemoteApi, its own answers not yet built (alone() null), the front door its own port. */
    const hostApi = async () => {
        const w = await watchModule();
        let view = VIEW;
        let poke = () => {};
        const feed = w.frontDoorWatchFeed({ read: () => view, onChange: (l) => { poke = l; return () => {}; } });
        const api = hostRemoteApi({ hostName: 'alphar', own: {}, alone: () => null, frontdoor: feed } as never);
        return { api, change: (next: View) => { view = next; poke(); } };
    };

    it('a page in this machine’s window, one only labelled Genie’s tray, or another machine is refused; main’s own client is answered with the view', async () => {
        const h0 = await hostApi();
        const c = connector();
        const h = await host(h0.api, c.transport);
        try {
            for (const preAuth of [PAGE, TRAY_LABEL_ONLY, RELAY]) {
                const other = await c.connect(preAuth);
                expect(await other.call(1, WATCH), JSON.stringify(preAuth)).toMatchObject({ ok: false });
            }
            const own = await c.connect(OWN);
            expect(await own.call(1, WATCH)).toMatchObject({ ok: true, value: VIEW });
        } finally { await h.done(); }
    });

    it('main’s own front-door watcher hears local-frontdoor when it changes, with genie-host’s own answers still unbuilt; no other connection hears it', async () => {
        const h0 = await hostApi();
        const c = connector();
        const h = await host(h0.api, c.transport);
        try {
            const own = await c.connect(OWN);
            await own.call(1, WATCH);
            const page = await c.connect(PAGE);
            const moved = { ...VIEW, port: 9443 };
            h0.change(moved);
            await settle();
            expect(own.events().map((e) => [e.channel, e.payload])).toEqual([['local-frontdoor', moved]]);
            expect(page.events().map((e) => e.channel)).not.toContain('local-frontdoor');
        } finally { await h.done(); }
    });

    it('END TO END: main’s own client watches the front door through RemoteHost and hostRemoteApi', async () => {
        const h0 = await hostApi();
        const home = await mkdtemp(join(tmpdir(), 'genie-2g4d-d1-e2e-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        try {
            const client = ownProtocolClient() as ReturnType<typeof ownProtocolClient> & { watchFrontDoor(onView: (view: View) => void): () => void };
            new RemoteHost({ api: h0.api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.4 }), confirm: allowEveryPairing, transport: client.door });
            const views: View[] = [];
            const stop = client.watchFrontDoor((v) => views.push(v));
            await settle();
            h0.change({ ...VIEW, routes: [] });
            await settle();
            expect(views).toEqual([VIEW, { ...VIEW, routes: [] }]);
            stop();
        } finally { await devices.flushed(); await rm(home, { recursive: true, force: true }); }
    });
});

describe('main’s side: the front door as genie-host says it', () => {
    function own() {
        let say: (view: View) => void = () => {};
        return { say: (v: View) => say(v), client: { watchFrontDoor: (l: (view: View) => void) => { say = l; return () => {}; } } };
    }

    it('before genie-host says anything it is no front door; then what it said; started once', async () => {
        const m = await windowModule();
        const o = own();
        const d = m.windowFrontDoor(o.client);
        d.start(); d.start();
        expect(d.now().port).toBe(0);
        o.say(VIEW);
        expect(d.now()).toEqual(VIEW);
    });

    it('a change says whether the port or the CA moved (the sessions are routed again) or only the sites did (the facts are said again)', async () => {
        const m = await windowModule();
        const o = own();
        const d = m.windowFrontDoor(o.client);
        d.start();
        const heard: Array<[number, boolean]> = [];
        d.onChange((view, moved) => heard.push([view.port, moved]));
        o.say(VIEW);
        o.say({ ...VIEW, sites: [] });
        o.say({ ...VIEW, sites: [], port: 9443 });
        o.say({ ...VIEW, sites: [], port: 9443, caPem: null, caReason: 'no CA' });
        expect(heard).toEqual([[8443, true], [8443, false], [9443, true], [9443, true]]);
    });

    it('ready once genie-host has said it, so the browser sessions and the site panels are made with the real front door; a host that never says is waited for no longer than the deadline', async () => {
        const m = await windowModule();
        const o = own();
        const d = m.windowFrontDoor(o.client);
        d.start();
        let ready = false;
        void d.ready(1_000).then(() => { ready = true; });
        await settle();
        expect(ready).toBe(false);
        o.say(VIEW);
        await settle();
        expect(ready).toBe(true);
        const silent = m.windowFrontDoor(own().client);
        silent.start();
        const at = Date.now();
        await silent.ready(30);
        expect(Date.now() - at).toBeLessThan(1_000);
        expect(silent.now().port).toBe(0);
    });
});

describe('wired: main reads the front door from the watch; genie-host feeds it, and pushes its Deck when the front door changes', () => {
    const main = code(src('src/main/main.ts'));

    it('main reads none of compose’s front door, routes or sites', () => {
        expect(main).not.toMatch(/composed\.(frontDoorPort|browserTrust|onFrontDoorChange|routes\(\)|sites\.)/);
        // CONTROL: the same scan sees what main still reads of compose's hosting.
        expect(main).toMatch(/composed\.untrustedNow/);
    });

    it('main watches the front door over its own client from boot, and waits for it before it builds the browser sessions and the site panels', () => {
        expect(main).toMatch(/const frontDoorWatch = windowFrontDoor\(ownProtocol\);/);
        expect(main).toMatch(/settingsNow\.start\(\);\s*frontDoorWatch\.start\(\);/);
        const at = (needle: string) => { const i = main.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
        expect(at('await frontDoorWatch.ready(FRONT_DOOR_BOOT_DEADLINE_MS);')).toBeLessThan(at('frontDoorNow = frontDoorWatch.now();'));
        expect(at('frontDoorNow = frontDoorWatch.now();')).toBeLessThan(at('livePanels = sitePanels({'));
        expect(main).toMatch(/frontDoorWatch\.onChange\(\(view, moved\) => \{/);
    });

    it('what the browser reads follows the watch: the pane’s routes, the site panels’ hosts and workspaces, the facts it is told, an agent’s site, a workspace’s tabs', () => {
        expect(main).toMatch(/routes: \(\) => frontDoorNow\.routes,/);
        expect(main).toMatch(/enabledHosts: \(\) => frontDoorNow\.routes\.map\(\(r\) => r\.host\)/);
        expect(main).toMatch(/workspaceOfHost: \(host\) => frontDoorNow\.sites\.find\(/);
        expect(main).toMatch(/workspaceOf: Object\.fromEntries\(frontDoorNow\.sites\.map\(/);
        expect(main).toMatch(/frontDoorNow\.sites\.find\(\(s\) => s\.host\.toLowerCase\(\) === host\)/);
        expect(main).toMatch(/sites: \(workspaceId\) => frontDoorNow\.sites\.filter\(\(s\) => s\.workspaceId === workspaceId\)\.map\(\(s\) => s\.host\),/);
    });

    it('genie-host feeds frontdoor.watch from its hosting, from its start, and touches its estate when its front door changes (#1010)', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/const frontDoorWatch = frontDoorWatchFeed\(\{ read: \(\) => frontDoorViewOf\(hostingStack\),/);
        expect(host).toMatch(/frontdoor: frontDoorWatch,/);
        expect(host.indexOf('const frontDoorWatch = frontDoorWatchFeed(')).toBeLessThan(host.indexOf('const remoteAccessHost = await RemoteAccessHost.open({'));
        // #1010: the Deck's Trust item is read with the estate; a front-door change touches it, as a store or session change does.
        expect(host).toMatch(/hostingStack\?\.onFrontDoorChange\(\(\) => \{ phoneTouch\(\); \}\);/);
        expect(code(src('src/main/remote-access-host.ts'))).toMatch(/ports\.frontdoor\?\.subscribe\(\(view\) => listener\(LOCAL_EVENTS\.frontdoor, view\)\)/);
    });
});
