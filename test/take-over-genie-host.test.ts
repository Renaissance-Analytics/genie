import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TakeOverProbe } from '../src/core/observed.js';
import type { AgentRecord } from '../src/core/identity.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { Store } from '../src/main/store.js';
import { TakeOverHost } from '../src/main/take-over-host.js';
import { TakeOverReplica } from '../src/main/take-over-replica.js';
import { TakeOverService } from '../src/main/take-over-service.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';

/*
 * TAKE OVER FROM A PILOT WITH EVERY WINDOW CLOSED (Tynn #553, host split P5d.5c). The take-over host lives in genie-host, the
 * one owner of who has a TUI open: a Pilot's click starts the TUI here with no window, and a window opened later sees it
 * and cannot start a second one on the same agent. The Take Over window on the Pilot then types into that terminal, and
 * when it closes the TUI ends.
 */

interface TakeOverView { live: Record<string, TakeOverProbe>; callers: Record<string, { agentId: string; agentName: string; workspaceId: string; workspacePath: string }> }
interface Service {
    start(agentId: unknown): { ok: true; terminalId: string; started?: boolean } | { ok: false; reason: string };
    ended(terminalId: string): void;
    view(): TakeOverView;
    call(method: string, args: unknown[]): unknown;
}
interface Replica {
    start(agentId: string): Promise<{ ok: true; terminalId: string; started?: boolean } | { ok: false; reason: string }>;
    windowClosed(terminalId: string): void;
    probe(id: string): TakeOverProbe | null;
    callerFor(id: string): TakeOverView['callers'][string] | null;
    callers(): TakeOverView['callers'];
    refresh(): Promise<void>;
    deliver(view: TakeOverView): void;
    onChange(listener: () => void): () => void;
}
interface Mods {
    TakeOverService: new (ports: Record<string, unknown>) => Service;
    TakeOverReplica: new (call: (method: string, args: readonly unknown[]) => Promise<unknown>) => Replica;
}

const mods = async (): Promise<Mods> => ({ TakeOverService, TakeOverReplica } as unknown as Mods);

const atlas = { id: 'agent_atlas', name: 'atlas', provider: 'claude', workspaceId: 'tynn' } as unknown as AgentRecord;

function terminals() {
    const opened: Array<{ cwd: string; command: string; workspaceId: string; env?: Record<string, string> }> = [];
    const closed: string[] = [];
    let onData: (id: string, data: string) => void = () => {};
    let onExit: (id: string, code: number) => void = () => {};
    return {
        opened, closed,
        api: {
            open: (o: (typeof opened)[number]) => { opened.push(o); return { id: `term_${opened.length}`, pid: 1, shell: o.command, scrollback: '' }; },
            close: (id: string) => { closed.push(id); return true; },
            onData: (l: typeof onData) => { onData = l; return () => {}; },
            onExit: (l: typeof onExit) => { onExit = l; return () => {}; },
        },
        data: (id: string, d: string) => onData(id, d),
        exit: (id: string) => onExit(id, 0),
    };
}

function timers() {
    let now = 1_000;
    const due: Array<{ at: number; fn: () => void }> = [];
    return {
        now: () => now,
        schedule: (ms: number, fn: () => void) => { const t = { at: now + ms, fn }; due.push(t); return () => { due.splice(due.indexOf(t), 1); }; },
        advance: (ms: number) => { now += ms; for (const t of due.filter((x) => x.at <= now)) { due.splice(due.indexOf(t), 1); t.fn(); } },
    };
}

async function rig(over: Record<string, unknown> = {}) {
    const { TakeOverService } = await mods();
    const t = terminals();
    const clock = timers();
    const windows: string[] = [];
    const host = new TakeOverHost({ terminals: t.api as never, openWindow: (route) => { windows.push(route); }, mcp: () => ({ mcpUrl: 'http://127.0.0.1:9/mcp', token: 'tok' }) });
    const pushed: TakeOverView[] = [];
    const service = new TakeOverService({
        host,
        find: (id: string) => (id === atlas.id ? atlas : null),
        workspacePath: () => '/w/tynn',
        tuiFor: () => 'claude',
        onChange: (view: TakeOverView) => pushed.push(view),
        schedule: clock.schedule,
        now: clock.now,
        ...over,
    });
    return { service, t, host, windows, pushed, clock };
}

describe('genie-host starts the TUI', () => {
    it('with no window: the provider\'s TUI, in the agent\'s workspace, and nothing opens on this screen', async () => {
        const r = await rig();
        expect(r.service.start(atlas.id)).toEqual({ ok: true, terminalId: 'term_1', started: true });
        expect(r.t.opened[0]).toMatchObject({ command: 'claude', cwd: '/w/tynn', workspaceId: 'tynn' });
        expect(r.windows).toEqual([]);
    });

    it('its TUI is given Genie\'s tools, and calls them as that agent', async () => {
        const r = await rig();
        r.service.start(atlas.id);
        const callerId = r.t.opened[0]!.env!['GENIE_TERMINAL_ID']!;
        expect(r.t.opened[0]!.env).toMatchObject({ GENIE_MCP_URL: 'http://127.0.0.1:9/mcp', GENIE_MCP_TOKEN: 'tok' });
        expect(r.service.view().callers[callerId]).toMatchObject({ agentId: atlas.id, workspacePath: '/w/tynn' });
    });

    it('one TUI per agent: a second click finds the first, and says it did not start it', async () => {
        const r = await rig();
        r.service.start(atlas.id);
        expect(r.service.start(atlas.id)).toEqual({ ok: true, terminalId: 'term_1', started: false });
        expect(r.t.opened).toHaveLength(1);
    });

    it('an agent this host does not know, or whose workspace is gone, is refused and nothing starts (CONTROL)', async () => {
        const r = await rig();
        expect(r.service.start('agent_nobody')).toEqual({ ok: false, reason: 'No agent is registered as agent_nobody.' });
        expect(r.service.start(7)).toEqual({ ok: false, reason: 'No agent named.' });
        const gone = await rig({ workspacePath: () => null });
        expect(gone.service.start(atlas.id)).toEqual({ ok: false, reason: 'atlas\'s workspace is not registered.' });
        expect(r.t.opened).toEqual([]);
        expect(gone.t.opened).toEqual([]);
    });

    it('when the Take Over window goes, the terminal goes with it', async () => {
        const r = await rig();
        r.service.start(atlas.id);
        r.service.ended('term_1');
        expect(r.t.closed).toEqual(['term_1']);
        expect(r.service.view().live).toEqual({});
    });

    it('what a window reads: pushed at once when the TUI starts, then at most once a second however fast it prints', async () => {
        const r = await rig();
        r.service.start(atlas.id);
        expect(r.pushed).toHaveLength(1);
        expect(Object.keys(r.pushed[0]!.live)).toEqual([atlas.id]);
        for (let i = 0; i < 50; i++) r.t.data('term_1', 'x');
        expect(r.pushed).toHaveLength(1);
        r.clock.advance(1_000);
        expect(r.pushed).toHaveLength(2);
        expect(r.pushed[1]!.live[atlas.id]!.bursts).toHaveLength(50);
    });

    it('the TUI exiting by itself is told too', async () => {
        const r = await rig();
        r.service.start(atlas.id);
        r.t.exit('term_1');
        r.clock.advance(1_000);
        expect(r.pushed.at(-1)!.live).toEqual({});
    });
});

describe('a window reads it through its replica', () => {
    const view: TakeOverView = {
        live: { [atlas.id]: { terminalId: 'term_1', startedAt: 5, lastOutputAt: null, bursts: [] } },
        callers: { takeover_1: { agentId: atlas.id, agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' } },
    };

    it('nothing is open until genie-host has said so', async () => {
        const { TakeOverReplica } = await mods();
        const replica = new TakeOverReplica(async () => view);
        expect(replica.probe(atlas.id)).toBeNull();
        expect(replica.callers()).toEqual({});
        await replica.refresh();
        expect(replica.probe(atlas.id)).toMatchObject({ terminalId: 'term_1' });
        expect(replica.callerFor('takeover_1')).toMatchObject({ agentName: 'atlas' });
    });

    it('a window opened after a Pilot\'s Take over sees it on first read', async () => {
        const { TakeOverReplica } = await mods();
        const calls: string[] = [];
        const replica = new TakeOverReplica(async (method) => { calls.push(method); return view; });
        await replica.refresh();
        expect(calls).toEqual(['status']);
        expect(replica.probe(atlas.id)).not.toBeNull();
    });

    it('Start and a closed window go to genie-host', async () => {
        const { TakeOverReplica } = await mods();
        const calls: Array<[string, readonly unknown[]]> = [];
        const replica = new TakeOverReplica(async (method, args) => { calls.push([method, args]); return { ok: true, terminalId: 'term_1', started: true }; });
        expect(await replica.start(atlas.id)).toEqual({ ok: true, terminalId: 'term_1', started: true });
        replica.windowClosed('term_1');
        expect(calls).toEqual([['start', [atlas.id]], ['ended', ['term_1']]]);
    });

    it('it says something changed only when the set of TUIs did, not for every burst of output', async () => {
        const { TakeOverReplica } = await mods();
        const replica = new TakeOverReplica(async () => view);
        const changed = vi.fn();
        replica.onChange(changed);
        replica.deliver(view);
        expect(changed).toHaveBeenCalledTimes(1);
        replica.deliver({ ...view, live: { [atlas.id]: { ...view.live[atlas.id]!, bursts: [{ at: 9, bytes: 3 }] } } });
        expect(changed).toHaveBeenCalledTimes(1);
        expect(replica.probe(atlas.id)!.bursts).toHaveLength(1);
        replica.deliver({ live: {}, callers: {} });
        expect(changed).toHaveBeenCalledTimes(2);
    });

    it('over the real engine link, from a local window only (CONTROL: a remote one is refused)', async () => {
        const r = await rig();
        const link = async (local: boolean) => {
            const server = new SessionEngineServer({ token: 't', build: 'b', takeOver: r.service } as never);
            const [h, raw] = memoryPair();
            server.accept(h, { local });
            const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage(l), onClose: (l) => raw.onClose(l), close: () => raw.close() };
            const client = new SessionEngineClient({});
            expect(await client.connect(t, 't')).toMatchObject({ ok: true });
            return { client, server };
        };
        const remote = await link(false);
        await expect(remote.client.call('engine.takeOver' as never, ['status', []] as never)).resolves.toEqual({ ok: false, reason: 'Take over is driven from a local window only.' });
        const local = await link(true);
        const replica = (local.client as unknown as { takeOvers(): Replica }).takeOvers();
        expect(await replica.start(atlas.id)).toMatchObject({ ok: true, terminalId: 'term_1' });
        await replica.refresh();
        expect(replica.probe(atlas.id)).toMatchObject({ terminalId: 'term_1' });
        (local.server as unknown as { takeOverEvent(view: TakeOverView): void }).takeOverEvent({ live: {}, callers: {} });
        await vi.waitFor(() => { expect(replica.probe(atlas.id)).toBeNull(); });
    });
});

describe('the Pilot\'s Take Over window with no window here', () => {
    let dir = '';
    let registry: Registry;
    const seen: Array<[string, unknown]> = [];

    const engine = { probe: () => null, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true } as unknown as HostAloneEngine;
    function term() {
        let data: (id: string, d: string) => void = () => {};
        let exit: (id: string, c: number) => void = () => {};
        const calls: string[] = [];
        return {
            calls, data: (id: string, d: string) => data(id, d), exit: (id: string) => exit(id, 0),
            api: {
                write: (id: string, d: string) => { calls.push(`write ${id} ${d}`); return true; },
                resize: (id: string, c: number, r: number) => { calls.push(`resize ${id} ${c}x${r}`); return true; },
                close: (id: string) => { calls.push(`close ${id}`); return true; },
                attach: (id: string) => ({ id, pid: 1, shell: 'claude', workspaceId: 'tynn', scrollback: 'hello' }),
                list: () => [{ id: 'term_1', pid: 1, shell: 'claude', workspaceId: 'tynn' }],
                onData: (l: typeof data) => { data = l; return () => {}; },
                onExit: (l: typeof exit) => { exit = l; return () => {}; },
            },
        };
    }
    const ports = (terminalsApi: unknown, over: Record<string, unknown> = {}) => ({
        hostName: 'alphar', registry, engine: () => engine, cwdFor: () => '/w', startRefusal: () => null,
        models: { get: async () => ({ models: [] }) }, providerInstalled: () => true, windowConnected: () => false, headroom: { view: () => ({}), subscribe: () => () => {} },
        attention: { finished: () => [], answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] }, deliverToAgent: async () => true,
        files: { children: async () => null, open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        terminals: terminalsApi,
        takeOver: () => null,
        settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {}, onChange: () => () => {} },
        ...over,
    }) as unknown as HostAlonePorts;
    const gate = (alone: HostApi, window: Partial<{ connected: () => boolean; invoke: HostApi['invoke'] }> = {}, more: Record<string, unknown> = {}) =>
        hostRemoteApi({ hostName: 'alphar', own: {}, window: { connected: () => false, invoke: async () => { throw new Error('the window was asked'); }, ...window }, alone, ...more } as never);

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-take-over-'));
        seen.length = 0;
        registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('it reads the scrollback, types, resizes and closes its terminal', async () => {
        const t = term();
        const api = gate(hostAloneApi(ports(t.api)));
        expect(await api.invoke('terminals.attach', ['tynn', 'term_1'])).toMatchObject({ id: 'term_1', scrollback: 'hello' });
        expect(await api.invoke('terminals.write', ['term_1', 'ls'])).toBe(true);
        expect(await api.invoke('terminals.resize', ['term_1', 80, 24])).toBe(true);
        expect(await api.invoke('terminals.close', ['term_1'])).toBe(true);
        expect(t.calls).toEqual(['write term_1 ls', 'resize term_1 80x24', 'close term_1']);
    });

    it('the TUI\'s output and its exit reach the Pilot', () => {
        const t = term();
        const api = gate(hostAloneApi(ports(t.api)));
        api.onEvent((channel, payload) => { if (channel.startsWith('terminal-')) seen.push([channel, payload]); });
        t.data('term_1', 'hi');
        t.exit('term_1');
        expect(seen).toEqual([['terminal-data', { id: 'term_1', data: 'hi' }], ['terminal-exit', { id: 'term_1', exitCode: 0 }]]);
    });

    it('opening or listing terminals is not part of this: still "open a window" (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports(term().api)));
        await expect(api.invoke('terminals.open', ['tynn', {}])).rejects.toThrow('open Genie on alphar');
        await expect(api.invoke('terminals.list', ['tynn'])).rejects.toThrow('open Genie on alphar');
    });

    it('with a window connected the window answers the terminal calls (CONTROL)', async () => {
        const t = term();
        const api = gate(hostAloneApi(ports(t.api)), { connected: () => true, invoke: async (method) => `window answered ${method}` });
        expect(await api.invoke('terminals.write', ['term_1', 'ls'])).toBe('window answered terminals.write');
        expect(t.calls).toEqual([]);
    });

    it('a Pilot\'s agent detail shows the TUI as Observed', async () => {
        const record = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const probe: TakeOverProbe = { terminalId: 'term_1', startedAt: 5, lastOutputAt: null, bursts: [] };
        const api = gate(hostAloneApi(ports(term().api, { takeOver: () => probe })));
        expect(await api.invoke('agentDetail', [record.id])).toMatchObject({ takeOver: { terminalId: 'term_1' } });
    });

    it('Take over itself is genie-host\'s, with a window or without', async () => {
        const own = vi.fn(async () => ({ ok: true, terminalId: 'term_1', started: true }));
        for (const connected of [false, true]) {
            const api = hostRemoteApi({ hostName: 'alphar', own: { takeOver: own }, window: { connected: () => connected, invoke: async () => { throw new Error('the window was asked'); } } });
            expect(await api.invoke('takeOver', [atlas.id])).toMatchObject({ terminalId: 'term_1' });
        }
        expect(own).toHaveBeenCalledTimes(2);
    });

    it('when a Pilot\'s Take Over window closes, the remote host can end the TUI', () => {
        const ended = vi.fn();
        const api = gate(hostAloneApi(ports(term().api)), {}, { takeOverEnded: ended });
        api.takeOverEnded?.('term_1');
        expect(ended).toHaveBeenCalledWith('term_1');
    });
});

describe('the wiring', () => {
    const src = (path: string) => readFileSync(path, 'utf8');

    it('genie-host owns it: the Pilot\'s call, its end, the window\'s link, the Observed row and the tools\' caller', () => {
        const host = src('src/main/genie-host.ts');
        expect(host).toContain('new TakeOverService(');
        expect(host).toMatch(/own: \{[^\n]*takeOver: async \(args\) => takeOverService\.start\(args\[0\]\)/);
        expect(host).toMatch(/takeOverEnded: \(terminalId\) => takeOverService\.ended\(terminalId\)/);
        expect(host).toMatch(/takeOver: takeOverService,/);
        expect(host).toMatch(/phoneRegistry\.setObservedProbe\(/);
        expect(host).toMatch(/takeOverCaller: \(id\) => takeOverHost\.callerFor\(id\)/);
    });

    it('a window with a genie-host asks it, and opens only its own window', () => {
        const main = src('src/main/main.ts');
        expect(main).toContain('agentEngineLink.client.takeOvers()');
        expect(main).toMatch(/await takeOvers\.start\(raw\)/);
    });

    it('the tools\' caller is found with no window having told the host', () => {
        expect(src('src/main/host-mcp.ts')).toMatch(/ports\.takeOverCaller\?\.\(id\)/);
    });
});
