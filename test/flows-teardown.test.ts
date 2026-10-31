import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore, type Actor } from '../src/main/flow-store.js';

/**
 * FLOWS — NOTHING IS WRITTEN AFTER THE SCHEDULER SAYS IT IS DONE (genie#1351).
 *
 * The acceptance suite caught `ENOENT … rename flows.json.<pid>.<n>.tmp -> flows.json` as an UNHANDLED rejection after
 * a Schedule test had passed and its folder was removed: a write of the flows file landed after teardown. Three gaps in
 * the product let that happen, each proven below:
 *
 * - `settled()` — what a quit and a test await — waited only for runs in flight. A HELD record (a fire that met the
 *   previous run still going, genie#1363's second fire among them) was written by nobody it waited for.
 * - The scheduler's timer outlived the quit: a fire during shutdown could start a run after `settled()` had answered.
 * - A record whose write failed was a promise nobody held: an unhandled rejection in the app, said nowhere.
 *
 * And the flows file had no "every write so far has landed" signal: the canvas acceptance test (e) read the file 50 ms
 * after the run reached its command, and on a loaded runner the write had not landed yet. `flushed()` is that signal.
 */

const user: Actor = { kind: 'user' };
const doc = (cron: string) => ({
    $schema: FLOW_SCHEMA_URL,
    version: 1,
    graph: {
        nodes: [
            { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron, timezone: 'UTC' } },
            { id: 'l', kind: 'log', position: { x: 200, y: 0 }, config: { message: 'tick' } },
        ],
        edges: [{ id: 'e1', source: 't', target: 'l' }],
    },
});

let dir: string;
let store: FlowStore;
let clock = 0;
const now = () => clock;
const utc = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 11, h, m, s);

function handTimer() {
    const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
    const live = () => timers.filter((t) => !t.cancelled);
    return {
        schedule(fn: () => void, ms: number) {
            const t = { at: clock + ms, fn, cancelled: false };
            timers.push(t);
            return () => { t.cancelled = true; };
        },
        armed: () => live().map((t) => t.at),
        runUntil(ms: number) {
            clock = ms;
            for (let guard = 0; guard < 100; guard += 1) {
                const due = live().filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0];
                if (!due) return;
                due.cancelled = true;
                due.fn();
            }
            throw new Error('the timer kept firing');
        },
    };
}

const onDisk = async () => JSON.parse(await readFile(join(dir, 'runtime', 'flows.json'), 'utf8')) as { flows: Array<{ id: string; inFlight?: unknown; runs: Array<{ outcome: string }> }> };

beforeEach(async () => {
    clock = utc(5, 3, 30);
    dir = await mkdtemp(join(tmpdir(), 'genie2-flows-teardown-'));
    store = await FlowStore.open(dir, now);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
});

describe('the scheduler answers settled() only when everything it started is written (genie#1351)', () => {
    it('a HELD record still being written keeps settled() waiting, and is on disk when it answers', async () => {
        const t = handTimer();
        let release!: () => void;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: () => new Promise<void>((r) => { release = r; }) });
        const flow = await store.create({ workspaceId: 'example', name: 'slow', document: doc('* * * * *'), by: user, armed: true });
        // The held record's write is slow (a loaded disk); the run's own record is not.
        let openGate!: () => void;
        const gate = new Promise<void>((r) => { openGate = r; });
        const real = store.recordRun.bind(store);
        vi.spyOn(store, 'recordRun').mockImplementation(async (id, run) => {
            if (run.outcome === 'held') await gate;
            return real(id, run);
        });
        scheduler.plan();
        t.runUntil(utc(5, 4)); // the 05:04 run starts and keeps going
        t.runUntil(utc(5, 5)); // 05:05 meets it: HELD, its record on its way
        release();
        let answered = false;
        const settled = scheduler.settled().then(() => { answered = true; });
        await vi.waitFor(async () => expect((await onDisk()).flows[0]!.runs.map((r) => r.outcome)).toEqual(['ran']));
        await new Promise((r) => setTimeout(r, 30));
        expect(answered).toBe(false);
        openGate();
        await settled;
        expect((await onDisk()).flows[0]!.runs.map((r) => r.outcome).sort()).toEqual(['held', 'ran']);
        expect(store.get(flow.id)!.runs).toHaveLength(2);
    });

    it('stop(): the armed timer is cancelled and NOTHING re-arms it — not a store change, not an explicit plan', async () => {
        const t = handTimer();
        let runs = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async () => { runs += 1; } });
        await store.create({ workspaceId: 'example', name: 'minutely', document: doc('* * * * *'), by: user, armed: true });
        scheduler.plan();
        expect(t.armed()).toEqual([utc(5, 4)]);
        scheduler.stop();
        expect(t.armed()).toEqual([]);
        expect(scheduler.nextDue()).toBeNull();
        await store.create({ workspaceId: 'example', name: 'later', document: doc('* * * * *'), by: user, armed: true });
        scheduler.plan();
        expect(t.armed()).toEqual([]);
        t.runUntil(utc(5, 10));
        await scheduler.settled();
        expect(runs).toBe(0);
    });

    it('a record that cannot be written is REPORTED with the flow’s name — never an unhandled rejection', async () => {
        const t = handTimer();
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async () => {} });
        await store.create({ workspaceId: 'example', name: 'nightly report', document: doc('* * * * *'), by: user, armed: true });
        vi.spyOn(store, 'recordRun').mockRejectedValue(new Error('ENOENT: no such file or directory, rename'));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
            scheduler.plan();
            t.runUntil(utc(5, 4));
            // Nobody awaits the scheduler here, as nobody does in the app between fires.
            await new Promise((r) => setTimeout(r, 50));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(unhandled).toEqual([]);
        expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/nightly report.*could not be recorded.*ENOENT/)]);
    });
});

describe('the flows file says when every write so far has landed (genie#1351)', () => {
    it('flushed(): a write nobody awaited (the run in flight, kept as it goes) is on disk once it resolves', async () => {
        const flow = await store.create({ workspaceId: 'example', name: 'long', document: doc('0 3 * * *'), by: user });
        for (let i = 0; i < 5; i += 1) void store.markInFlight(flow.id, { at: new Date(clock).toISOString(), trigger: 'manual', nodes: { t: 'ran', l: i < 4 ? 'running' : 'ran' } });
        await store.flushed();
        expect((await onDisk()).flows[0]!.inFlight).toEqual({ at: new Date(clock).toISOString(), trigger: 'manual', nodes: { t: 'ran', l: 'ran' } });
    });

    it('flushed() with nothing written resolves at once', async () => {
        await expect(store.flushed()).resolves.toBeUndefined();
    });
});
