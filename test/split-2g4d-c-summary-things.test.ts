import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { alertSound } from '../src/core/alerts.js';
import { EMPTY_HOST_SUMMARY, hostSummaryFeed, hostSummaryOf, readHostSummary, type HostSummary } from '../src/core/host-summary.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { LOCAL_EVENTS, inMemoryPair, parseMessage, type ServerTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { readThingSignal, sayThings, type ThingActionSignal } from '../src/core/thing-sounds.js';
import { OWN_CLIENT_LABEL, ownProtocolClient } from '../src/main/own-protocol-client.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4d-C (Tynn #1045; part of #955). The summary genie-host says to main's own client gains the
 * processes it runs, its active services and the sites it routes, by name, so main's tray count, its Restart/Shut-down list
 * and its quit plan read the summary and none of compose's replicas. And genie-host, which runs the things, says their
 * sounds itself, on the tool-signal path, as it says the mail sounds (2g-4b1); main only checks what it is sent.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const block = (text: string, start: string, end = '\n}\n') => { const i = text.indexOf(start); expect(i, start).toBeGreaterThan(-1); const j = text.indexOf(end, i); expect(j, start).toBeGreaterThan(i); return text.slice(i, j); };
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

const processes = [
    { name: 'queue worker', state: 'running' }, { name: 'vite', state: 'restarting' }, { name: 'old build', state: 'exited' },
    { name: 'broken', state: 'failed' }, { name: 'asked to stop', state: 'stopped' }, { name: 'coming up', state: 'starting' },
];
const services = [{ engine: 'postgres', version: '17', active: true }, { engine: 'postgres', version: '16', active: false }, { engine: 'redis', version: '7', active: true }];
const routes = [{ host: 'shop.gen' }, { host: 'mail.gen' }];
const RUNS = { processes, services, routes };

describe('the host summary carries the processes, the services and the sites, by name', () => {
    it('the processes running or restarting, the active services (engine and version), the routed sites; with none said, none', () => {
        const s = hostSummaryOf([], [], [], undefined, RUNS);
        expect(s.processes).toEqual(['queue worker', 'vite']);
        expect(s.services).toEqual(['postgres 17', 'redis 7']);
        expect(s.sites).toEqual(['shop.gen', 'mail.gen']);
        expect(hostSummaryOf([], [], [])).toMatchObject({ processes: [], services: [], sites: [] });
        expect(EMPTY_HOST_SUMMARY).toMatchObject({ processes: [], services: [], sites: [] });
    });

    it('READER, fail closed: read as said; any of the three absent or not a list of names is the EMPTY summary, whatever else it says', () => {
        const said = { terminals: [{ workspaceId: 'ws_a', pid: 1 }], armedFlows: ['nightly'], scheduledTasks: [], workstationRole: 'pilot', tynnAccountKey: 'k', keychainReady: true, githubBlocked: false, processes: ['vite'], services: ['postgres 17'], sites: ['shop.gen'] };
        // CONTROL: a whole summary reads as it was said, so the refusals below are the reader's and not a broken fixture.
        expect(readHostSummary(said)).toEqual(said);
        for (const member of ['processes', 'services', 'sites'] as const) {
            const { [member]: _gone, ...without } = said;
            expect(readHostSummary(without), `${member} absent`).toEqual(EMPTY_HOST_SUMMARY);
            for (const bad of [null, 'vite', 3, [1], ['ok', null], [{ name: 'vite' }], { 0: 'vite', length: 1 }]) expect(readHostSummary({ ...said, [member]: bad }), `${member}=${JSON.stringify(bad)}`).toEqual(EMPTY_HOST_SUMMARY);
        }
        // What is read is the reader's own copy: changing what came in afterwards changes nothing main holds.
        const lists = { processes: ['vite'], services: ['postgres 17'], sites: ['shop.gen'] };
        const read = readHostSummary({ ...said, ...lists });
        lists.processes.push('planted'); lists.services.push('planted'); lists.sites.push('planted');
        expect(read).toMatchObject({ processes: ['vite'], services: ['postgres 17'], sites: ['shop.gen'] });
    });

    it('CHANGE-ONLY: a process that restarts, a stopped one that exits and an inactive service say nothing new; a process that starts or ends, a service made active and a new site each say it once', () => {
        const now = { processes: [...processes], services: [...services], routes: [...routes] };
        let fire: () => void = () => {};
        const feed = hostSummaryFeed({ read: () => hostSummaryOf([], [], [], undefined, now), onChange: (l) => { fire = l; return () => {}; } });
        const heard: HostSummary[] = [];
        feed.subscribe((s) => heard.push(s));
        fire();
        now.processes[0] = { name: 'queue worker', state: 'restarting' };
        now.processes[4] = { name: 'asked to stop', state: 'exited' };
        now.services.push({ engine: 'mysql', version: '8', active: false });
        fire();
        expect(heard).toEqual([]);
        now.processes[5] = { name: 'coming up', state: 'running' };
        fire(); fire();
        expect(heard.map((s) => s.processes)).toEqual([['queue worker', 'vite', 'coming up']]);
        now.processes[1] = { name: 'vite', state: 'failed' };
        fire();
        now.services[1] = { engine: 'postgres', version: '16', active: true };
        fire();
        now.routes.push({ host: 'docs.gen' });
        fire(); fire();
        expect(heard.slice(1).map((s) => [s.processes.length, s.services.length, s.sites.length])).toEqual([[2, 2, 2], [2, 3, 2], [2, 3, 3]]);
        expect(feed.now()).toMatchObject({ processes: ['queue worker', 'coming up'], services: ['postgres 17', 'postgres 16', 'redis 7'], sites: ['shop.gen', 'mail.gen', 'docs.gen'] });
    });
});

describe('OWN ONLY: what genie-host runs is said to main’s own client, and to nobody else', () => {
    const FULL = hostSummaryOf([{ workspaceId: 'ws_a', pid: 7 }], [], [], undefined, RUNS);
    async function host(transport: ServerTransport) {
        let emit: (channel: string, payload: unknown) => void = () => {};
        const api = { workspaceOfAgent: () => null, invoke: async () => null, hostSummary: () => FULL, onEvent: (l: (channel: string, payload: unknown) => void) => { emit = l; return () => {}; } } as unknown as HostApi;
        const home = await mkdtemp(join(tmpdir(), 'genie-2g4dc-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        const remote = new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing, transport });
        return { remote, emit: (channel: string, payload: unknown) => emit(channel, payload), done: async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); } };
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
            const call = async (id: number, method: string) => {
                pair.client.send(JSON.stringify({ kind: 'call', id, method, args: [] }));
                await settle();
                return frames.find((m) => m.kind === 'result' && m.id === id) as Extract<WireMessage, { kind: 'result' }> | undefined;
            };
            return { frames, call };
        };
        return { transport, connect };
    };
    const OWN = { kind: 'local', label: OWN_CLIENT_LABEL, isOwner: true, workspaceId: null, readonly: false, window: 'main', own: true };
    const PAGE = { kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false, window: 'main' };
    const TRAY_LABEL_ONLY = { ...PAGE, label: OWN_CLIENT_LABEL };
    const OWN_BUT_FAR = { kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false, own: true };
    const RELAY = { kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false };
    const names = (frames: WireMessage[]) => JSON.stringify(frames);

    it('a page in this machine’s window, one only labelled Genie’s tray, and another machine (even one that says own) are refused and learn no name; main’s own client is answered with them', async () => {
        const c = connector();
        const h = await host(c.transport);
        try {
            const others = [];
            for (const preAuth of [PAGE, TRAY_LABEL_ONLY, RELAY, OWN_BUT_FAR]) {
                const other = await c.connect(preAuth);
                expect(await other.call(1, 'summary.watch'), JSON.stringify(preAuth)).toMatchObject({ ok: false });
                others.push(other);
            }
            // CONTROL: main's own client is answered, with the processes, the services and the sites.
            const own = await c.connect(OWN);
            expect(await own.call(1, 'summary.watch')).toMatchObject({ ok: true, value: { processes: ['queue worker', 'vite'], services: ['postgres 17', 'redis 7'], sites: ['shop.gen', 'mail.gen'] } });
            // ...and each change after it reaches the watcher only: a refused connection hears no summary, whatever it asked.
            h.emit(LOCAL_EVENTS.summary, { ...FULL, processes: ['secret worker'] });
            await settle();
            expect(names(own.frames)).toContain('secret worker');
            for (const other of others) { expect(names(other.frames)).not.toContain('secret worker'); expect(names(other.frames)).not.toContain('queue worker'); expect(names(other.frames)).not.toContain('shop.gen'); }
        } finally { await h.done(); }
    });

    it('main’s own client reads them: at once, and as they change', async () => {
        const own = ownProtocolClient();
        const h = await host(own.door);
        const heard: HostSummary[] = [];
        const stop = own.watchSummary((s) => heard.push(s));
        try {
            await settle();
            expect(heard).toEqual([FULL]);
            const next = hostSummaryOf([], [], [], undefined, { processes: [], services: [], routes: [{ host: 'docs.gen' }] });
            h.emit(LOCAL_EVENTS.summary, next);
            // A summary that does not read reaches main as the empty one, never as half of one.
            h.emit(LOCAL_EVENTS.summary, { ...next, sites: 'docs.gen' });
            await settle();
            expect(heard).toEqual([FULL, next, EMPTY_HOST_SUMMARY]);
        } finally { stop(); await h.done(); }
    });
});

describe('genie-host says the sounds of what it runs', () => {
    function sources() {
        const fire = { process: (_s: { id: string; state: string }) => {}, sites: () => {}, started: (_id: string) => {}, run: (_id: string, _run: { outcome: 'ran' | 'failed' | 'held' | 'stopped' }) => {} };
        let sites = [{ id: 'site_a', state: 'running', processIds: ['site_a', 'site_a:php1'] }];
        return {
            fire,
            setSites: (list: typeof sites) => { sites = list; },
            ports: {
                supervisor: { onChange: (l: typeof fire.process) => { fire.process = l; return () => {}; } },
                sites: { list: () => sites, onChange: (l: () => void) => { fire.sites = l; return () => {}; } },
                engines: { onStarted: (l: typeof fire.started) => { fire.started = l; return () => {}; } },
                flows: { onRun: (l: typeof fire.run) => { fire.run = l; return () => {}; } },
            },
        };
    }

    it('a process that exits, a site down and up again, a service started and a flow run finished: each said once, agentless', () => {
        const s = sources();
        const said: ThingActionSignal[] = [];
        sayThings(s.ports, (signal) => said.push(signal));
        // The first sight of a thing is its baseline: nothing sounds because genie-host started.
        expect(said).toEqual([]);
        s.fire.process({ id: 'p1', state: 'running' });
        s.fire.process({ id: 'p1', state: 'exited' });
        s.fire.process({ id: 'p1', state: 'exited' });
        expect(said).toEqual([{ agentId: null, kind: 'exits' }]);
        // A site's own server is the site's row: its process says nothing; the site does.
        s.fire.process({ id: 'site_a:php1', state: 'running' });
        s.fire.process({ id: 'site_a:php1', state: 'failed' });
        expect(said).toHaveLength(1);
        s.setSites([{ id: 'site_a', state: 'failed', processIds: ['site_a', 'site_a:php1'] }]);
        s.fire.sites();
        s.setSites([{ id: 'site_a', state: 'running', processIds: ['site_a', 'site_a:php1'] }]);
        s.fire.sites(); s.fire.sites();
        s.fire.started('engine_1');
        s.fire.run('flow_1', { outcome: 'ran' });
        s.fire.run('flow_1', { outcome: 'held' });
        s.fire.run('flow_1', { outcome: 'stopped' });
        s.fire.run('flow_1', { outcome: 'failed' });
        expect(said.map((x) => x.kind)).toEqual(['exits', 'sitedown', 'siteup', 'serviceup', 'flowdone', 'flowdone']);
        for (const x of said) expect(x.agentId).toBeNull();
    });

    it('a host with no hosting says its processes and its flows; nothing throws for the sites and services it does not have', () => {
        const s = sources();
        const said: ThingActionSignal[] = [];
        sayThings({ supervisor: s.ports.supervisor, sites: null, engines: null, flows: s.ports.flows }, (signal) => said.push(signal));
        s.fire.process({ id: 'site_a', state: 'running' });
        s.fire.process({ id: 'site_a', state: 'exited' });
        s.fire.run('flow_1', { outcome: 'ran' });
        expect(said.map((x) => x.kind)).toEqual(['exits', 'flowdone']);
    });

    it('READER: main passes on only an agentless thing sound; an agent’s name, another kind or anything more is not one', () => {
        for (const kind of ['exits', 'siteup', 'sitedown', 'serviceup', 'flowdone']) expect(readThingSignal({ agentId: null, kind })).toEqual({ agentId: null, kind });
        // What goes on is the reader's own members — and the workspace it happened in (Tynn #1057: its sidebar row shows it) —
        // never what else came with them.
        expect(readThingSignal({ agentId: null, kind: 'exits', workspaceId: 'ws_a', sound: 'alarm' })).toEqual({ agentId: null, kind: 'exits', workspaceId: 'ws_a' });
        expect(readThingSignal({ agentId: null, kind: 'exits', workspaceId: '', sound: 'alarm' })).toEqual({ agentId: null, kind: 'exits' });
        for (const bad of [null, 7, 'exits', {}, { kind: 'exits' }, { agentId: 'a1', kind: 'exits' }, { agentId: null, kind: 'question' }, { agentId: null, kind: 'limit-alert' }, { agentId: null, kind: 'terminal-needs-you' }, { agentId: null, kind: 'account-switch' }, { agentId: null, kind: 'toString' }, { agentId: null, kind: ['exits'] }, { agentId: undefined, kind: 'exits' }]) {
            expect(readThingSignal(bad), JSON.stringify(bad)).toBeNull();
        }
    });
});

describe('ACTIVITY SOUNDS ARE A CLIENT SETTING (the owner): genie-host only says that a thing happened', () => {
    const SILENT = { notification_sounds: false, do_not_disturb: true, sound_exits: 'off', sound_siteup: 'off', sound_sitedown: 'off', sound_serviceup: 'off', sound_flowdone: 'off' };

    it('the host says each thing whatever any sound setting is: it is handed no setting, and the same signals are silence in one client and sounds in another', () => {
        const fire = { process: (_s: { id: string; state: string }) => {}, sites: () => {}, started: (_id: string) => {}, run: (_id: string, _run: { outcome: 'ran' | 'failed' | 'held' | 'stopped' }) => {} };
        let sites = [{ id: 'site_a', state: 'running', processIds: ['site_a'] }];
        const said: ThingActionSignal[] = [];
        // Every sound off and Do not disturb on, in a settings store beside the sources: nothing of it reaches what is said.
        const sources = {
            settings: { snapshot: () => SILENT, data: () => ({ values: SILENT }) },
            supervisor: { onChange: (l: typeof fire.process) => { fire.process = l; return () => {}; } },
            sites: { list: () => sites, onChange: (l: () => void) => { fire.sites = l; return () => {}; } },
            engines: { onStarted: (l: typeof fire.started) => { fire.started = l; return () => {}; } },
            flows: { onRun: (l: typeof fire.run) => { fire.run = l; return () => {}; } },
        };
        sayThings(sources, (signal) => said.push(signal));
        fire.process({ id: 'p1', state: 'running' }); fire.process({ id: 'p1', state: 'failed' });
        sites = [{ id: 'site_a', state: 'exited', processIds: ['site_a'] }]; fire.sites();
        sites = [{ id: 'site_a', state: 'running', processIds: ['site_a'] }]; fire.sites();
        fire.started('engine_1');
        fire.run('flow_1', { outcome: 'ran' });
        expect(said).toEqual([{ agentId: null, kind: 'exits' }, { agentId: null, kind: 'sitedown' }, { agentId: null, kind: 'siteup' }, { agentId: null, kind: 'serviceup' }, { agentId: null, kind: 'flowdone' }]);
        // The signal says what happened and nothing about a sound: no file, no volume, no mute.
        for (const signal of said) expect(Object.keys(signal).sort()).toEqual(['agentId', 'kind']);
        // THE CLIENT DECIDES, from its own settings: the same five signals are silence in one window...
        expect(said.map((signal) => alertSound(signal.kind, SILENT))).toEqual([null, null, null, null, null]);
        // ...and, CONTROL, sounds in another (so the silence above is the setting's, not a kind nobody plays).
        const LOUD = { notification_sounds: true, sound_exits: 'synth', sound_siteup: 'synth', sound_sitedown: 'synth', sound_serviceup: 'synth', sound_flowdone: 'synth' };
        for (const signal of said) expect(alertSound(signal.kind, LOUD), signal.kind).not.toBeNull();
    });

    it('nothing on the host side of the path reads a sound setting; the window that plays it does', () => {
        const SETTING = /settings|sound_|notification_sounds|do_not_disturb|alertSound|volume|mute/i;
        // CONTROL: the scan finds a setting read where there is one (the window's own decision).
        const app = code(src('src/renderer/App.tsx'));
        // Which sound is the settings' choice; how loud is this client's own level (Tynn #1022): both read in the window.
        // (Through soundAndCue since Tynn #1057: the sound and its cue in one call.)
        expect(app).toContain('if (ALERT_KINDS.some((k) => k.kind === action.kind)) soundAndCue({ sound: alertSound(action.kind as AlertKind, soundSettings.current ?? {}), volume: alertVolume(action.kind as AlertKind, clientSoundValues()), cue: cueOfAction(action, cueAgents.current, Date.now(), nextCueId()), settings: soundSettings.current ?? {}, add: keepCue });');
        expect(SETTING.test(app)).toBe(true);
        // The module that hears the things and says them: its only import is the kinds' type.
        const things = code(src('src/core/thing-sounds.ts'));
        expect([...things.matchAll(/^import .*$/gm)].map((m) => m[0].trim())).toEqual(["import type { AlertKind } from './alerts.js';"]);
        expect(things).not.toMatch(SETTING);
        // genie-host's own line, and main's line that hands the signal on: neither asks a setting.
        const hostLine = code(src('src/main/genie-host.ts')).split('\n').filter((l) => l.includes('sayThings('));
        expect(hostLine).toHaveLength(1);
        expect(hostLine[0]).not.toMatch(SETTING);
        const mainLine = code(src('src/main/main.ts')).split('\n').filter((l) => l.includes("signal.kind === 'thing'"));
        expect(mainLine).toHaveLength(1);
        expect(mainLine[0]).not.toMatch(SETTING);
    });
});

describe('wired', () => {
    const host = code(src('src/main/genie-host.ts'));
    const main = code(src('src/main/main.ts'));

    it('genie-host reads the three from its own supervisor and hosting, and reads again when any of them changes', () => {
        const feed = block(host, 'const hostSummary = hostSummaryFeed({', '\n    });');
        expect(feed).toMatch(/\{ processes: processSupervisor\.list\(\), services: hostingStack\?\.engines\.list\(\) \?\? \[\], routes: hostingStack\?\.routes\(\) \?\? \[\] \}/);
        expect(feed).toMatch(/processSupervisor\.onChange\(\(\) => listener\(\)\)/);
        expect(feed).toMatch(/hostingStack\?\.sites\.onChange\(listener\)/);
        expect(feed).toMatch(/hostingStack\?\.engines\.onChange\(listener\)/);
        expect(host).toMatch(/gappRouteListeners\.add\(pokeSummary\);/);
    });

    it('genie-host says the thing sounds on the tool-signal path, from its own supervisor, sites, engines and flows', () => {
        expect(host).toMatch(/sayThings\(\{ supervisor: processSupervisor, sites: hostingStack\?\.sites \?\? null, engines: hostingStack\?\.engines \?\? null, flows: hostFlows \}, \(thing\) => \{ engine\.callback\(\{ name: 'toolSignal', signal: \{ kind: 'thing', thing \} \}\); \}\);/);
        expect(host.match(/sayThings\(/g)).toHaveLength(1);
    });

    it('main hands on what reads as one, and makes no thing sound of its own', () => {
        expect(main).toMatch(/signal\.kind === 'thing'\) \{ const thing = readThingSignal\(\(raw as \{ thing\?: unknown \}\)\.thing\); if \(thing\) broadcast\('genie:action', thing\); \}/);
        expect(main).not.toMatch(/ThingSounds|flowRunSound|sayThings|siteProcess/);
        expect(main).not.toMatch(/composed\.(supervisor\.onChange|engines\.onStarted|flows\.onRun)\(/);
        expect(main).not.toMatch(/kind: 'serviceup'/);
    });

    it('main’s tray count, its Restart/Shut-down list and its quit plan read the summary, and no replica of compose', () => {
        // The count of what runs is genie-host's own since Tynn #1058 L5 (engine.activity, for the launcher's tray), from its
        // summary; the client counts nothing for a tray.
        expect(main).not.toMatch(/function hostActivityNow\(/);
        expect(code(src('src/main/genie-host.ts'))).toMatch(/activity: \(\) => hostActivityOf\(\{[\s\S]{0,200}summary: hostSummary\.now\(\),/);
        const stopping = block(main, 'function stoppingNow(');
        expect(stopping).toMatch(/processes: \[\.\.\.hostSummaryNow\.processes\], services: \[\.\.\.hostSummaryNow\.services\], sites: \[\.\.\.hostSummaryNow\.sites\]/);
        const quit = block(main, "app.on('before-quit'", '\n});');
        expect(quit).toMatch(/\{ keptProcesses: hostSummaryNow\.processes\.length, \.\.\.onTheClockNow\(\) \}/);
        // CONTROL: the three blocks are the ones the scan means (each reads the summary's terminals too).
        for (const b of [activity, stopping, quit]) { expect(b).toMatch(/hostSummaryNow\.terminals/); expect(b).not.toMatch(/(?<![.\w])services[?!]?\.|composed\./); }
        // No read of the supervisor's, the engines' or the routes' replica is left for them anywhere in main.
        expect(main).not.toMatch(/services\?\.(supervisor|engines)\.list\(\)|services\?\.routes\(\)/);
    });
});
