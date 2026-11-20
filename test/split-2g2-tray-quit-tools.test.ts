import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMPTY_HOST_SUMMARY, hostSummaryFeed, hostSummaryOf, readHostSummary } from '../src/core/host-summary.js';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { runQuit, type QuitPorts } from '../src/core/quit.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { CONTROL_METHODS, LOCAL_EVENTS, inMemoryPair, parseMessage, type RemoteMethod, type ServerTransport, type WireMessage } from '../src/core/remote-protocol.js';
import { onTheClock } from '../src/core/tray-only.js';
import { ownProtocolClient } from '../src/main/own-protocol-client.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-2 (Tynn #898, story #953; part of #913). A client is a dumb terminal. main's tray, its
 * Restart/Shut-down list and its quit plan read what genie-host runs synchronously, so they read ONE summary genie-host
 * pushes when it changes (the live terminals, the armed flows, the scheduled tasks), over main's own protocol client
 * (`summary.watch`), instead of the engine link's terminals and process-book replicas. genie-host ends its own terminals
 * when it shuts down, so a quit has no terminal step of its own. main's MCP tool server keeps no host-native tool deps
 * (manageTerminals, processes and flows always run in genie-host), and its never-read workspace saver goes.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

const terminals = [{ id: 't1', workspaceId: 'ws_a', pid: 101 }, { id: 't2', workspaceId: 'ws_b', pid: 202 }];
const flows = [{ name: 'nightly', armed: true }, { name: 'draft', armed: false }];
const kept = [{ name: 'backup', wanted: true, schedule: { every: '1h' } }, { name: 'worker', wanted: true }, { name: 'paused', wanted: false, schedule: { every: '1h' } }];

describe('the host summary: what genie-host runs, as the tray and the quit read it', () => {
    it('the live terminals (workspace and pid), the armed flows and the scheduled tasks, by name', () => {
        expect(hostSummaryOf(terminals, flows, kept)).toEqual({
            terminals: [{ workspaceId: 'ws_a', pid: 101 }, { workspaceId: 'ws_b', pid: 202 }],
            armedFlows: ['nightly'],
            scheduledTasks: ['backup'],
            // Not said here: a drone signed out, fail closed (the role and the account, Tynn #954 2g-3a).
            workstationRole: 'drone',
            tynnAccountKey: null,
        });
    });

    it('counts exactly what onTheClock counts: the same rule, read from the summary', () => {
        const s = hostSummaryOf(terminals, flows, kept);
        expect({ armedFlows: s.armedFlows.length, scheduledTasks: s.scheduledTasks.length }).toEqual(onTheClock(flows, kept));
    });

    it('read from the wire: a malformed summary is the empty one, never a throw', () => {
        expect(readHostSummary({ terminals: [{ workspaceId: 'ws_a', pid: 1 }], armedFlows: ['x'], scheduledTasks: [] })).toEqual({ terminals: [{ workspaceId: 'ws_a', pid: 1 }], armedFlows: ['x'], scheduledTasks: [], workstationRole: 'drone', tynnAccountKey: null });
        expect(readHostSummary(null)).toEqual(EMPTY_HOST_SUMMARY);
        expect(readHostSummary({ terminals: 'no', armedFlows: [1], scheduledTasks: null })).toEqual(EMPTY_HOST_SUMMARY);
    });

    it('the feed says it only when it changed', () => {
        let now = hostSummaryOf(terminals, flows, kept);
        let fire: () => void = () => {};
        const feed = hostSummaryFeed({ read: () => now, onChange: (l) => { fire = l; return () => {}; } });
        const heard: unknown[] = [];
        feed.subscribe((s) => heard.push(s));
        fire();
        expect(heard).toEqual([]);
        now = hostSummaryOf(terminals.slice(0, 1), flows, kept);
        fire();
        fire();
        expect(heard).toEqual([now]);
        expect(feed.now()).toEqual(now);
    });
});

describe('over the wire: main’s summary connection', () => {
    async function host(api: Partial<HostApi>, transport: ServerTransport) {
        const home = await mkdtemp(join(tmpdir(), 'genie-2g2-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        const remote = new RemoteHost({ api: { workspaceOfAgent: () => null, onEvent: () => () => {}, invoke: async () => null, ...api } as HostApi, hostName: 'alphar', baton: new Baton(), devices,
            pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing, transport });
        return { remote, done: async () => { await devices.flushed(); await rm(home, { recursive: true, force: true }); } };
    }

    it('summary.watch is a control; main’s client hears the summary at once and as it changes, and nothing else', async () => {
        expect(CONTROL_METHODS as readonly string[]).toContain('summary.watch');
        let emit: (channel: string, payload: unknown) => void = () => {};
        const first = hostSummaryOf(terminals, flows, kept);
        const own = ownProtocolClient();
        const h = await host({ hostSummary: () => first, onEvent: (l) => { emit = l; return () => {}; } }, own.door);
        const heard: unknown[] = [];
        const stop = own.watchSummary((s) => heard.push(s));
        try {
            await settle();
            expect(heard).toEqual([first]);
            const next = hostSummaryOf([], flows, kept);
            emit(LOCAL_EVENTS.summary, next);
            emit(LOCAL_EVENTS.snapshot, { deckItems: [] });
            emit(LOCAL_EVENTS.updates, { state: 'idle' });
            await settle();
            expect(heard).toEqual([first, next]);
        } finally { stop(); await h.done(); }
    });

    it('a window that did not ask hears no summary; another machine cannot ask', async () => {
        let emit: (channel: string, payload: unknown) => void = () => {};
        let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void = () => {};
        const h = await host({ hostSummary: () => EMPTY_HOST_SUMMARY, onEvent: (l) => { emit = l; return () => {}; } }, { onConnection: (l) => { accept = l; return () => {}; } });
        const connect = async (preAuth: Record<string, unknown>) => {
            const pair = inMemoryPair();
            const frames: WireMessage[] = [];
            pair.client.onMessage((m) => { const r = parseMessage(m); if (r.ok) frames.push(r.message); });
            accept({ ...pair.server, preAuth: preAuth as never });
            pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: preAuth.kind }, label: 'x' }));
            await settle();
            return { pair, frames };
        };
        try {
            const window = await connect({ kind: 'local', label: 'a window', isOwner: true, workspaceId: null, readonly: false, window: 'main' });
            const far = await connect({ kind: 'relay', label: 'laptop', isOwner: true, workspaceId: null, readonly: false });
            emit(LOCAL_EVENTS.summary, EMPTY_HOST_SUMMARY);
            far.pair.client.send(JSON.stringify({ kind: 'call', id: 9, method: 'summary.watch', args: [] }));
            await settle();
            expect(window.frames.filter((m) => m.kind === 'event' && (m as { channel?: string }).channel === LOCAL_EVENTS.summary)).toEqual([]);
            expect(far.frames.find((m) => m.kind === 'result' && m.id === 9)).toMatchObject({ ok: false });
        } finally { await h.done(); }
    });
});

describe('genie-host computes it and ends its own terminals at shutdown', () => {
    const host = code(src('src/main/genie-host.ts'));

    it('composed over its terminal host, its flows and its process book, said on each of their changes', () => {
        expect(host).toMatch(/const hostSummary = hostSummaryFeed\(\{\s*read: \(\) => hostSummaryOf\(terminalHost\.list\(\), hostFlows\.list\(\), hostBook\.kept\(\)\),/);
        expect(host).toMatch(/terminalHost\.onChange\(listener\)/);
        expect(host).toMatch(/hostSummary,/);
    });

    it('its shutdown ends the terminals it holds, after the sessions stop and before the hosted processes', () => {
        const shutdown = /async function shutdown\(why: string\)[\s\S]*?process\.exit\(0\);/.exec(host)?.[0] ?? '';
        const stopped = shutdown.indexOf('host.stopAll()');
        const closed = shutdown.indexOf('terminalHost.closeAll()');
        const hosted = shutdown.indexOf('await stopHostedOnce()');
        expect(stopped).toBeGreaterThan(-1);
        expect(closed).toBeGreaterThan(stopped);
        expect(hosted).toBeGreaterThan(closed);
    });
});

describe('a quit has no terminal step of its own: genie-host ends its terminals', () => {
    it('runQuit: agents, the window, the drain, then the host', async () => {
        const calls: string[] = [];
        const p: QuitPorts = {
            stopAgents: () => { calls.push('stopAll'); },
            closeWindow: () => { calls.push('window'); },
            drained: async () => { calls.push('drained'); },
            shutDownHost: async () => { calls.push('engine.shutdown'); },
        };
        await runQuit(p);
        expect(calls).toEqual(['stopAll', 'window', 'drained', 'engine.shutdown']);
        expect(code(src('src/core/quit.ts'))).not.toContain('closeTerminals');
    });
});

describe('main reads the summary; no terminals or process-book replica, no host-native tool deps', () => {
    const main = code(src('src/main/main.ts'));

    it('the tray’s count, its Restart/Shut-down list and the quit plan read the summary', () => {
        expect(main).toMatch(/ownProtocol\.watchSummary\(\(summary\) => \{[\s\S]{0,240}?hostSummaryNow = summary;\s*refreshTray\(\);\s*\}\)/);
        expect(main).toMatch(/terminals: hostSummaryNow\.terminals\.length/);
        expect(main).toMatch(/const terminalsOpen = hostSummaryNow\.terminals\.map\(/);
        expect(main).toMatch(/liveTerminals: hostSummaryNow\.terminals\.length/);
        expect(main).toMatch(/armedFlows: hostSummaryNow\.armedFlows\.length, scheduledTasks: hostSummaryNow\.scheduledTasks\.length/);
    });

    it('main reaches neither replica, and the rows leave both lists', () => {
        for (const use of ['terminals', 'processBook']) {
            expect(main, use).not.toMatch(new RegExp(`client\\??\\.${use}\\(`));
            expect(WINDOW_ENGINE_INVENTORY.map(([u]) => u), use).not.toContain(use);
            expect(src('test/split-2e-window-guard.test.ts'), use).not.toMatch(new RegExp(`\\b${use}: '2g'`));
        }
    });

    it('its MCP tool server keeps no host-native deps: terminals is the host’s, processes and flows are absent', () => {
        expect(main).toMatch(/terminals: hostOnly<TerminalsPort>\('the terminals'\),/);
        expect(main).not.toMatch(/processes: \{ book: processBook/);
        expect(main).not.toMatch(/flows: \{ store: composed\.flows/);
        for (const gone of ['processBook', 'processScheduler', 'workspaceSaver', 'closeTerminals']) expect(main, gone).not.toContain(gone);
    });

    it('CONTROL: those tools never run in the window: genie-host runs them', () => {
        const tools = code(src('src/main/mcp-host-tools.ts'));
        expect(tools).toMatch(/HOST_NATIVE_TOOLS: ReadonlySet<string> = new Set\(\[[^\]]*'processes', 'flows', 'manageTerminals'/);
        expect(tools).not.toMatch(/manageTerminals: new Set|processes: new Set|flows: new Set/);
    });
});
