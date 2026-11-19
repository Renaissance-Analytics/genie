import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { TYPING_EVENT, type RemoteMethod } from '../src/core/remote-protocol.js';
import { hostAloneApi, HOST_ALONE_METHODS, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * CLIENT/HOST SPLIT STEP 2d-1 (Tynn #898, P4 #332): GENIE-HOST ANSWERS WHAT IT OWNS FOR EVERY CLIENT, WINDOW OR NOT.
 *
 * Until now a remote client's call went to the newest local WINDOW whenever one was connected, and genie-host answered
 * its own families (HOST_ALONE_METHODS) only with every window closed, building no activity feed and pushing none of
 * its own events meanwhile. So a phone or a paired device saw a different source depending on whether someone had a
 * window open. Now genie-host answers them, and its events are the ones every remote client hears; the window answers
 * only what genie-host does not own yet (terminals.open/list, addAgent, inbox.sendFile: step 2d-2) and only until
 * genie-host's own answers are ready at boot.
 */

let dir = '';
let registry: Registry;
let atlas: AgentRecord;
let ledgerReads = 0;

function engine() {
    const subscribers = new Set<(id: string) => void>();
    return {
        probe: () => null,
        subscribe: (l: (id: string) => void) => { subscribers.add(l); return () => subscribers.delete(l); },
        ledgerFor: () => { ledgerReads += 1; return []; },
        rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(),
        needsNewDriver: () => false, notice: () => true,
        emit: (id: string) => { for (const l of subscribers) l(id); },
    } as unknown as HostAloneEngine & { emit(id: string): void };
}

function timers() {
    const due: Array<() => void> = [];
    return { schedule: (_ms: number, fn: () => void) => { due.push(fn); return () => {}; }, run: () => { for (const fn of due.splice(0)) fn(); } };
}

function ports(e: HostAloneEngine, over: Record<string, unknown> = {}): HostAlonePorts {
    return {
        hostName: 'alphar', registry, engine: () => e, cwdFor: () => '/w', startRefusal: () => null,
        models: { get: async () => ({ models: [] }) }, providerInstalled: () => true,
        attention: { finished: () => [], answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] },
        deliverToAgent: async () => true,
        files: { children: async () => [], open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true, list: () => [], onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null,
        headroom: { view: () => ({ claude: { leftPct: 40 } }), subscribe: () => () => {} },
        settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {}, onChange: () => () => {} },
        ...over,
    } as unknown as HostAlonePorts;
}

/** A connected window that records what it was asked and can push events of its own. */
function connectedWindow() {
    const asked: string[] = [];
    const listeners = new Set<(channel: string, payload: unknown) => void>();
    return {
        asked,
        port: { connected: () => true, invoke: async (method: RemoteMethod) => { asked.push(method); return `window answered ${method}`; } },
        onEvent: (listener: (channel: string, payload: unknown) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        push: (channel: string, payload: unknown) => { for (const l of listeners) l(channel, payload); },
    };
}

function gate(alone: HostApi | null, window: ReturnType<typeof connectedWindow>): HostApi {
    return hostRemoteApi({ hostName: 'alphar', own: {}, window: window.port, onEvent: window.onEvent, alone: () => alone });
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-split-2d1-'));
    ledgerReads = 0;
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
    atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('with a window connected, genie-host still answers what it owns', () => {
    it.each([
        ['snapshot', []],
        ['agents.setMode', ['ATLAS', 'automated']],
        ['agents.diagnose', ['ATLAS']],
        ['activity', ['tynn']],
        ['headroom', []],
        ['files.children', ['tynn', '']],
        ['workspaces.settings', ['tynn']],
    ] as const)('%s is answered by genie-host and the window is never asked', async (method, rawArgs) => {
        const alone = hostAloneApi(ports(engine()));
        const invoke = vi.spyOn(alone, 'invoke');
        const window = connectedWindow();
        const args = rawArgs.map((a) => (a === 'ATLAS' ? atlas.id : a));
        const answer = await gate(alone, window).invoke(method as RemoteMethod, [...args]);
        expect(answer).not.toBe(`window answered ${method}`);
        expect(invoke).toHaveBeenCalledWith(method, args, undefined);
        expect(window.asked).toEqual([]);
    });

    it('a write lands in genie-host\'s registry (agents.setMode), not through the window', async () => {
        const window = connectedWindow();
        await gate(hostAloneApi(ports(engine())), window).invoke('agents.setMode', [atlas.id, 'automated']);
        expect(registry.find(atlas.id)?.mode).toBe('automated');
        expect(window.asked).toEqual([]);
    });

    it('every method genie-host owns is routed to it (the whole set, not a sample)', async () => {
        const alone = { invoke: vi.fn(async () => 'host'), onEvent: () => () => {}, workspaceOfAgent: () => null } as unknown as HostApi;
        const window = connectedWindow();
        const api = gate(alone, window);
        for (const method of HOST_ALONE_METHODS) expect(await api.invoke(method, [])).toBe('host');
        expect(window.asked).toEqual([]);
    });
});

describe('the window answers only what genie-host does not own yet', () => {
    it.each(['terminals.open', 'terminals.list', 'addAgent', 'inbox.sendFile'] as const)('%s still goes to the connected window (step 2d-2 moves it)', async (method) => {
        const window = connectedWindow();
        expect(await gate(hostAloneApi(ports(engine())), window).invoke(method, [])).toBe(`window answered ${method}`);
    });

    it('while genie-host\'s own answers are still being built at boot, a connected window answers (CONTROL)', async () => {
        const window = connectedWindow();
        expect(await gate(null, window).invoke('snapshot', [])).toBe('window answered snapshot');
    });
});

describe('events: genie-host\'s own, for every remote client', () => {
    it('with a window connected genie-host\'s events reach the listener, and the window\'s copies of them do not', () => {
        const window = connectedWindow();
        const alone = hostAloneApi(ports(engine()));
        const seen: string[] = [];
        gate(alone, window).onEvent((channel) => { seen.push(channel); });
        registry.touch();
        window.push('snapshot', { from: 'the window' });
        expect(seen.filter((c) => c === 'snapshot')).toHaveLength(1);
    });

    it('what someone types in this machine\'s window still reaches remote clients (typing has no store behind it)', () => {
        const window = connectedWindow();
        const seen: Array<[string, unknown]> = [];
        gate(hostAloneApi(ports(engine())), window).onEvent((channel, payload) => { seen.push([channel, payload]); });
        window.push(TYPING_EVENT, { agentId: atlas.id, text: 'hi' });
        expect(seen).toEqual([[TYPING_EVENT, { agentId: atlas.id, text: 'hi' }]]);
    });

    it('genie-host builds the activity feed with a window connected (a remote client reads it)', () => {
        const e = engine(), clock = timers();
        const api = hostAloneApi(ports(e, { schedule: clock.schedule }));
        api.onEvent(() => {}, { wantsAgent: () => false });
        e.emit(atlas.id);
        clock.run();
        expect(ledgerReads).toBeGreaterThan(0);
    });

    it('genie-host no longer asks whether a window is connected before building its answers or pushing its estate', () => {
        const alone = readFileSync('src/main/host-alone-api.ts', 'utf8');
        expect(alone).not.toMatch(/windowConnected/);
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        expect(host).not.toMatch(/if \(engine\.newestLocalWindow\(\) === null\) phone/);
    });
});
