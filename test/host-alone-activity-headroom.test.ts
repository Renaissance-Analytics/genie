import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as board from '../src/core/headroom-board.js';
import type { Headroom } from '../src/core/headroom.js';
import type { AgentRecord } from '../src/core/identity.js';
import { LOCAL_EVENTS } from '../src/core/remote-protocol.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * THE DASHBOARD'S LANES AND RATE LIMITS WITH EVERY WINDOW CLOSED (Tynn #553, host split P5d.5b). genie-host builds each
 * agent's activity feed from its own session host, and keeps each provider's latest rate-limit reading, so what a Pilot
 * reads does not depend on a window being open here. With a window connected the window answers, and genie-host spends
 * nothing building feeds nobody it serves will read.
 */

let dir = '';
let registry: Registry;
let atlas: AgentRecord;
let vega: AgentRecord;
let ledgerReads = 0;

interface Feed { agentId: string }
interface FeedBoard { view(): Record<string, Headroom>; subscribe(l: (room: Record<string, Headroom>) => void): () => void; offer(provider: string, room: Headroom): void }

const room = (leftPct: number): Headroom => ({ plan: null, window: '5h', leftPct, resetsAtMs: 1, over: false, windows: [{ window: '5h', leftPct, resetsAtMs: 1, over: false }] } as unknown as Headroom);

function engine() {
    const subscribers = new Set<(id: string) => void>();
    return {
        probe: () => null,
        subscribe: (l: (id: string) => void) => { subscribers.add(l); return () => subscribers.delete(l); },
        ledgerFor: () => { ledgerReads += 1; return []; },
        rowsFor: () => [],
        turnsFor: () => 0,
        recentStderrFor: () => [],
        refusals: new Map(),
        needsNewDriver: () => false,
        notice: () => true,
        emit: (id: string) => { for (const l of subscribers) l(id); },
    } as unknown as HostAloneEngine & { emit(id: string): void };
}

/** A fake clock's worth of timers: nothing fires until the test says so. */
function timers() {
    const due: Array<() => void> = [];
    return { schedule: (_ms: number, fn: () => void) => { due.push(fn); return () => {}; }, run: () => { for (const fn of due.splice(0)) fn(); } };
}

function ports(e: HostAloneEngine, over: Record<string, unknown> = {}): HostAlonePorts {
    return {
        hostName: 'alphar',
        registry,
        engine: () => e,
        cwdFor: () => '/w',
        startRefusal: () => null,
        models: { get: async () => ({ models: [] }) },
        providerInstalled: () => true,
        attention: { finished: () => [], answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true },
        inbox: { unread: () => [], receive: async () => [], involving: () => [] },
        deliverToAgent: async () => true,
        files: { children: async () => null, open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        windowConnected: () => false,
        terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true, list: () => [], onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null,
        headroom: { view: () => ({}), subscribe: () => () => {} },
        ...over,
    } as unknown as HostAlonePorts;
}

function gate(alone: HostApi, window: Partial<{ connected: () => boolean; invoke: HostApi['invoke'] }> = {}): HostApi {
    return hostRemoteApi({ hostName: 'alphar', own: {}, window: { connected: () => false, invoke: async () => { throw new Error('the window was asked'); }, ...window }, alone });
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-host-alone-activity-'));
    ledgerReads = 0;
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
    await registry.addWorkspace({ id: 'moic', path: '/w/moic' });
    atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
    vega = await registry.register({ workspaceId: 'moic', provider: 'claude', name: 'vega' });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the activity feeds with no window', () => {
    it('one workspace\'s agents, and only theirs', async () => {
        const feeds = (await gate(hostAloneApi(ports(engine()))).invoke('activity', ['tynn'])) as Record<string, Feed>;
        expect(Object.keys(feeds)).toEqual([atlas.id]);
        expect(feeds[atlas.id]!.agentId).toBe(atlas.id);
        expect(Object.keys(feeds)).not.toContain(vega.id);
    });

    it('a session change reaches a Pilot as that agent\'s feed, one per burst', async () => {
        const e = engine();
        const clock = timers();
        const api = gate(hostAloneApi(ports(e, { schedule: clock.schedule })));
        const seen: Feed[] = [];
        api.onEvent((channel, payload) => { if (channel === 'activity') seen.push(payload as Feed); });
        e.emit(atlas.id);
        e.emit(atlas.id);
        expect(seen).toEqual([]);
        clock.run();
        expect(seen.map((f) => f.agentId)).toEqual([atlas.id]);
    });

    it('with a window connected no feed is built, and the window answers (CONTROL)', async () => {
        const e = engine();
        const clock = timers();
        const alone = hostAloneApi(ports(e, { schedule: clock.schedule, windowConnected: () => true }));
        const invoke = vi.spyOn(alone, 'invoke');
        const api = gate(alone, { connected: () => true, invoke: async (method) => `window answered ${method}` });
        // No agent watched: an agent's detail reads the ledger too, and this counts only what the feeds read.
        api.onEvent(() => {}, { wantsAgent: () => false });
        e.emit(atlas.id);
        clock.run();
        expect(ledgerReads).toBe(0);
        expect(await api.invoke('activity', ['tynn'])).toBe('window answered activity');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('the same change with no window does read the ledger (CONTROL: the count above can move)', async () => {
        const e = engine();
        const clock = timers();
        hostAloneApi(ports(e, { schedule: clock.schedule }));
        e.emit(atlas.id);
        clock.run();
        expect(ledgerReads).toBeGreaterThan(0);
    });
});

describe('the rate limits with no window', () => {
    it('genie-host answers with what its own board holds', async () => {
        const api = gate(hostAloneApi(ports(engine(), { headroom: { view: () => ({ claude: room(38) }), subscribe: () => () => {} } })));
        expect(await api.invoke('headroom', [])).toEqual({ claude: room(38) });
    });

    it('a new reading is pushed as the local event', () => {
        let push: (r: Record<string, Headroom>) => void = () => {};
        const api = hostAloneApi(ports(engine(), { headroom: { view: () => ({}), subscribe: (l: typeof push) => { push = l; return () => {}; } } }));
        const seen: Array<[string, unknown]> = [];
        api.onEvent((channel, payload) => { if (channel === LOCAL_EVENTS.headroom) seen.push([channel, payload]); });
        push({ claude: room(12) });
        expect(seen).toEqual([[LOCAL_EVENTS.headroom, { claude: room(12) }]]);
    });

    it('with a window connected the window answers (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports(engine())), { connected: () => true, invoke: async (method) => `window answered ${method}` });
        expect(await api.invoke('headroom', [])).toBe('window answered headroom');
    });
});

describe('one board for the window and genie-host', () => {
    /** Reached loosely so these are red by assertion, not by a compile error, until it exists. */
    const make = (bufferMs: () => number, now: () => number): FeedBoard => {
        const Feed = (board as unknown as { HeadroomFeed?: new (bufferMs: () => number, now: () => number) => FeedBoard }).HeadroomFeed;
        expect(Feed, 'HeadroomFeed').toBeTypeOf('function');
        return new Feed!(bufferMs, now);
    };

    it('a reading that clears its buffer is kept and pushed once', () => {
        const feed = make(() => 60_000, () => 1_000);
        const pushed: unknown[] = [];
        feed.subscribe((r) => pushed.push(r));
        feed.offer('claude', room(40));
        expect(pushed).toEqual([{ claude: room(40) }]);
        expect(feed.view()).toEqual({ claude: room(40) });
    });

    it('a reading inside the buffer is ignored: nothing kept, nothing pushed (CONTROL)', () => {
        let now = 1_000;
        const feed = make(() => 60_000, () => now);
        feed.offer('claude', room(40));
        const pushed: unknown[] = [];
        feed.subscribe((r) => pushed.push(r));
        now = 30_000;
        feed.offer('claude', room(10));
        expect(pushed).toEqual([]);
        expect(feed.view()).toEqual({ claude: room(40) });
        now = 70_000;
        feed.offer('claude', room(10));
        expect(pushed).toEqual([{ claude: room(10) }]);
    });

    it('the buffer is read at each reading, so the setting applies without a restart', () => {
        let buffer = 60_000;
        let now = 1_000;
        const feed = make(() => buffer, () => now);
        feed.offer('claude', room(40));
        buffer = 1_000;
        now = 5_000;
        feed.offer('claude', room(10));
        expect(feed.view()).toEqual({ claude: room(10) });
    });
});

describe('the wiring', () => {
    const src = (path: string) => readFileSync(path, 'utf8');

    it('genie-host keeps every reading itself, and still tells a connected window', () => {
        const host = src('src/main/genie-host.ts');
        expect(host).toMatch(/onHeadroom: \(provider, room\) => \{ headroomFeed\.offer\(provider, room\); engineHostOptions\.onHeadroom\(provider, room\); \}/);
        expect(host).toMatch(/windowConnected: \(\) => engine\.newestLocalWindow\(\) !== null/);
        expect(host).toMatch(/headroom: headroomFeed/);
    });

    it('the window uses the same board and the same workspace filter', () => {
        const main = src('src/main/main.ts');
        expect(main).toContain('new HeadroomFeed(');
        expect(main).not.toContain('new HeadroomBoard(');
        expect(main).toContain('activityOfWorkspace(');
        expect(src('src/main/host-alone-api.ts')).toContain('activityOfWorkspace(');
    });
});
