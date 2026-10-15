import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { FlowScheduler, type RunResult } from '../src/main/flow-scheduler.js';
import { FlowStore, type Actor } from '../src/main/flow-store.js';

/**
 * FLOWS — EVERY flow due at an instant runs (the Windows acceptance's 2b, 2026-10-15).
 *
 * The VM armed two flows on `* * * * *`: "accept every minute" ran at 09:57, 09:58 and 09:59; "accept
 * failing", armed on the same schedule, never ran at all ("not run yet", `runs: []` in flows.json, no line in
 * its command's log). The scheduler held ONE timer for ONE flow: the nearest due, ties going to the first
 * armed flow in the store's order, so every minute the same flow won and the other was never fired. The
 * timer is a wake-up; everything due at its instant runs. Counted per flow, across several dues, with a
 * DISARMED flow on the same schedule as the control that "every due flow" does not mean "every flow".
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

function fakeClock() {
    const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
    return {
        schedule(fn: () => void, ms: number) {
            const t = { at: clock + ms, fn, cancelled: false };
            timers.push(t);
            return () => { t.cancelled = true; };
        },
        pending: () => timers.filter((t) => !t.cancelled && t.at > clock).length,
        advanceTo(ms: number) {
            clock = ms;
            for (const t of timers.splice(0)) {
                if (t.cancelled) continue;
                if (t.at <= clock) t.fn();
                else timers.push(t);
            }
        },
    };
}

beforeEach(async () => {
    clock = Date.UTC(2026, 9, 11, 5, 3, 30);
    dir = await mkdtemp(join(tmpdir(), 'genie2-flows-tie-'));
    store = await FlowStore.open(dir, now);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('the scheduler — every armed flow due at the same instant runs', () => {
    it('two ARMED flows on `* * * * *` BOTH run every minute (counted over 3 dues); a DISARMED one on the same schedule never does', async () => {
        const fc = fakeClock();
        const ran = new Map<string, number>();
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: async (flow) => { ran.set(flow.name, (ran.get(flow.name) ?? 0) + 1); } });
        await store.create({ workspaceId: 'example', name: 'first', document: doc('* * * * *'), by: user, armed: true });
        await store.create({ workspaceId: 'example', name: 'second', document: doc('* * * * *'), by: user, armed: true });
        await store.create({ workspaceId: 'example', name: 'off', document: doc('* * * * *'), by: user });
        scheduler.plan();

        for (const m of [4, 5, 6]) {
            fc.advanceTo(Date.UTC(2026, 9, 11, 5, m, 0));
            await scheduler.settled();
            // Still ONE timer: one wake-up for the next minute, whatever is due at it.
            expect(fc.pending()).toBe(1);
        }
        expect(ran.get('first')).toBe(3);
        expect(ran.get('second')).toBe(3);
        expect(ran.get('off')).toBeUndefined();
    });

    it('flows on DIFFERENT schedules that coincide (every minute and every five) both run at 05:05, and only the every-minute one at 05:04 and 05:06', async () => {
        const fc = fakeClock();
        const ran: string[] = [];
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: async (flow) => { ran.push(`${new Date(clock).toISOString().slice(11, 16)} ${flow.name}`); } });
        await store.create({ workspaceId: 'example', name: 'minutely', document: doc('* * * * *'), by: user, armed: true });
        await store.create({ workspaceId: 'example', name: 'every5', document: doc('*/5 * * * *'), by: user, armed: true });
        scheduler.plan();
        for (const m of [4, 5, 6]) {
            fc.advanceTo(Date.UTC(2026, 9, 11, 5, m, 0));
            await scheduler.settled();
        }
        expect(ran.sort()).toEqual(['05:04 minutely', '05:05 every5', '05:05 minutely', '05:06 minutely']);
    });

    it('each flow due together keeps ITS OWN outcome: one fails with its exit code, the other ran — neither replaces the other', async () => {
        const fc = fakeClock();
        const scheduler = new FlowScheduler({
            store,
            now,
            schedule: fc.schedule,
            run: async (flow): Promise<RunResult> => (flow.name === 'failing' ? { outcome: 'failed', reason: 'node tick.cjs failing ended with exit code 3' } : { outcome: 'ran' }),
        });
        const good = await store.create({ workspaceId: 'example', name: 'good', document: doc('* * * * *'), by: user, armed: true });
        const bad = await store.create({ workspaceId: 'example', name: 'failing', document: doc('* * * * *'), by: user, armed: true });
        scheduler.plan();
        for (const m of [4, 5]) {
            fc.advanceTo(Date.UTC(2026, 9, 11, 5, m, 0));
            await scheduler.settled();
        }
        expect(store.get(good.id)!.runs.map((r) => [r.at, r.outcome])).toEqual([
            ['2026-10-11T05:04:00.000Z', 'ran'],
            ['2026-10-11T05:05:00.000Z', 'ran'],
        ]);
        expect(store.get(bad.id)!.runs.map((r) => [r.at, r.outcome, r.reason])).toEqual([
            ['2026-10-11T05:04:00.000Z', 'failed', 'node tick.cjs failing ended with exit code 3'],
            ['2026-10-11T05:05:00.000Z', 'failed', 'node tick.cjs failing ended with exit code 3'],
        ]);
    });

    it('a flow with TWO triggers due at the same instant runs ONCE then (not a second, held-back copy)', async () => {
        const fc = fakeClock();
        let runs = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: async () => { runs += 1; } });
        const twice = {
            $schema: FLOW_SCHEMA_URL,
            version: 1,
            graph: {
                nodes: [
                    { id: 't1', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '* * * * *', timezone: 'UTC' } },
                    { id: 't2', kind: 'schedule_trigger', position: { x: 0, y: 120 }, config: { cron: '*/5 * * * *', timezone: 'UTC' } },
                    { id: 'l', kind: 'log', position: { x: 200, y: 0 }, config: { message: 'tick' } },
                ],
                edges: [{ id: 'e1', source: 't1', target: 'l' }, { id: 'e2', source: 't2', target: 'l' }],
            },
        };
        const f = await store.create({ workspaceId: 'example', name: 'two triggers', document: twice, by: user, armed: true });
        scheduler.plan();
        fc.advanceTo(Date.UTC(2026, 9, 11, 5, 5, 0));
        await scheduler.settled();
        expect(runs).toBe(1);
        expect(store.get(f.id)!.runs.map((r) => r.outcome)).toEqual(['ran']);
    });
});
