import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { TYPING_EVENT, type RemoteMethod, type CallContext } from '../src/core/remote-protocol.js';
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
 * window open. Now genie-host answers them, and its events are the ones every remote client hears. Since step 2d-2b it
 * answers every other method too, and no call is ever sent to a window (Tynn #898).
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

/** genie-host's remote API over its own answers. No window relays events into it (Tynn #898 step 2d-4b2). */
function gate(alone: HostApi | null): HostApi {
    return hostRemoteApi({ hostName: 'alphar', own: {}, alone: () => alone });
}
/** This machine's window, as genie-host's RemoteHost admits it through its tunnel (Tynn #898 step 2d-4b). */
const THIS_WINDOW: CallContext = { connectionId: 'rc_window', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'alphar' };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-split-2d1-'));
    ledgerReads = 0;
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
    atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('genie-host answers what it owns, every client alike', () => {
    it.each([
        ['snapshot', []],
        ['agents.setMode', ['ATLAS', 'automated']],
        ['agents.diagnose', ['ATLAS']],
        ['activity', ['tynn']],
        ['headroom', []],
        ['files.children', ['tynn', '']],
        ['workspaces.settings', ['tynn']],
    ] as const)('%s is answered by genie-host', async (method, rawArgs) => {
        const alone = hostAloneApi(ports(engine()));
        const invoke = vi.spyOn(alone, 'invoke');
        const args = rawArgs.map((a) => (a === 'ATLAS' ? atlas.id : a));
        await gate(alone).invoke(method as RemoteMethod, [...args]);
        expect(invoke).toHaveBeenCalledWith(method, args, undefined);
    });

    it('a write lands in genie-host\'s registry (agents.setMode)', async () => {
        await gate(hostAloneApi(ports(engine()))).invoke('agents.setMode', [atlas.id, 'automated']);
        expect(registry.find(atlas.id)?.mode).toBe('automated');
    });

    it('every method genie-host owns is routed to it (the whole set, not a sample)', async () => {
        const alone = { invoke: vi.fn(async () => 'host'), onEvent: () => () => {}, workspaceOfAgent: () => null } as unknown as HostApi;
        const api = gate(alone);
        for (const method of HOST_ALONE_METHODS) expect(await api.invoke(method, [])).toBe('host');
    });
});

describe('no call goes to a window (step 2d-2b)', () => {
    it.each(['host.home', 'host.listDir', 'openAgent', 'resolvePrompt'] as const)('%s is genie-host\'s too', async (method) => {
        const alone = hostAloneApi(ports(engine()));
        const invoke = vi.spyOn(alone, 'invoke');
        await gate(alone).invoke(method, []).catch(() => null);
        expect(invoke).toHaveBeenCalledWith(method, [], undefined);
    });

    it('while genie-host\'s own answers are still being built at boot, a call is told to try again (CONTROL)', async () => {
        await expect(gate(null).invoke('snapshot', [])).rejects.toThrow(/still starting; try again in a moment/);
    });
});

describe('events: genie-host\'s own, for every remote client', () => {
    it('genie-host\'s events reach the listener: exactly one snapshot per change, its registry\'s estate', () => {
        const alone = hostAloneApi(ports(engine()));
        const snapshots: unknown[] = [];
        gate(alone).onEvent((channel, payload) => { if (channel === 'snapshot') snapshots.push(payload); });
        registry.touch();
        expect(snapshots).toHaveLength(1);
        expect((snapshots[0] as { agents: Array<{ id: string }> }).agents.map((a) => a.id)).toContain(atlas.id);
    });

    it('what someone types in this machine\'s window reaches remote clients: the window is genie-host\'s connection, so genie-host publishes it', async () => {
        const seen: Array<[string, unknown]> = [];
        const api = gate(hostAloneApi(ports(engine())));
        api.onEvent((channel, payload) => { if (channel === TYPING_EVENT) seen.push([channel, payload]); });
        await api.invoke('agents.typing', [atlas.id, 'hi', 'window-client'], THIS_WINDOW);
        // This machine's own window is named by nobody (null), as before.
        expect(seen).toEqual([[TYPING_EVENT, { agentId: atlas.id, text: 'hi', source: 'window-client', label: null }]]);
    });

    it('genie-host builds the activity feed with a window connected (a remote client reads it)', () => {
        const e = engine(), clock = timers();
        // Told a window is connected, as genie-host used to be: it builds the feed anyway (an older build built none).
        const api = hostAloneApi(ports(e, { schedule: clock.schedule, windowConnected: () => true }));
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
