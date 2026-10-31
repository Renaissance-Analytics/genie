import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore, type Actor } from '../src/main/flow-store.js';

/**
 * FLOWS — ONE SLOT, ONE RUN (genie#1363).
 *
 * The scheduler arms one timer for a due instant (a SLOT). Node fires that timer from its own monotonic loop clock,
 * which it reads once per loop turn and in whole milliseconds; the scheduler's "now" is the wall clock (`Date.now`).
 * So the timer can wake while the wall clock still reads a little BEFORE the slot — by up to a millisecond always, and
 * by the whole of a long synchronous turn when the timer was set late in one (measured on omarchy-test: see the PR).
 * The scheduler re-planned from "now" after a fire, and the cron's next instant after `slot - 1 ms` is the slot itself:
 * it armed the same slot again, fired it again a moment later and ran the flow a second time (or recorded a `held`
 * run beside the first). The acceptance suite saw it in 2 of 36 runs on the VM.
 *
 * Each case drives the timer by hand: the clock is set to what the wall reads when the timer wakes, and the armed
 * callback is called. Early, late, the wall clock set back after a fire and moved forward before one, and both
 * daylight-saving days.
 */

const user: Actor = { kind: 'user' };
const doc = (cron: string, timezone = 'UTC') => ({
    $schema: FLOW_SCHEMA_URL,
    version: 1,
    graph: {
        nodes: [
            { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron, timezone } },
            { id: 'l', kind: 'log', position: { x: 200, y: 0 }, config: { message: 'tick' } },
        ],
        edges: [{ id: 'e1', source: 't', target: 'l' }],
    },
});

let dir: string;
let store: FlowStore;
let clock = 0;
const now = () => clock;

/** The scheduler's timer, by hand: each armed callback with the instant it was aimed at (the wall reading + its delay). */
function handTimer() {
    const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
    const live = () => timers.filter((t) => !t.cancelled);
    return {
        schedule(fn: () => void, ms: number) {
            const t = { at: clock + ms, fn, cancelled: false };
            timers.push(t);
            return () => { t.cancelled = true; };
        },
        /** The instants of the timers still armed. */
        armed: () => live().map((t) => t.at),
        /** The wall clock reads `reading` when the armed timer wakes: call it, whatever the reading says. */
        wake(reading: number) {
            const next = live().sort((a, b) => a.at - b.at)[0];
            if (!next) throw new Error('no timer armed');
            next.cancelled = true;
            clock = reading;
            next.fn();
        },
        /** Let wall time reach `ms`: every timer aimed at or before it fires, as a real timer would. */
        runUntil(ms: number) {
            clock = ms;
            for (let guard = 0; guard < 100; guard += 1) {
                const due = live().filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0];
                if (!due) return;
                due.cancelled = true;
                due.fn();
            }
            throw new Error('the timer kept firing at the same time');
        },
    };
}

const utc = (h: number, m: number, s = 0, ms = 0) => Date.UTC(2026, 9, 11, h, m, s, ms);

beforeEach(async () => {
    clock = utc(5, 3, 30);
    dir = await mkdtemp(join(tmpdir(), 'genie2-flows-slot-'));
    store = await FlowStore.open(dir, now);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function armed(name: string, cron: string, timezone?: string) {
    return store.create({ workspaceId: 'example', name, document: doc(cron, timezone), by: user, armed: true });
}

describe('the scheduler — a slot that fired is never planned or run again (genie#1363)', () => {
    it('EARLY by 1 ms: the timer wakes while the wall clock reads 05:03:59.999 — the 05:04 slot runs ONCE and the next plan is 05:05', async () => {
        const t = handTimer();
        let runs = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async () => { runs += 1; } });
        const flow = await armed('minutely', '* * * * *');
        scheduler.plan();
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: utc(5, 4) });

        t.wake(utc(5, 4) - 1);
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: utc(5, 5) });
        await scheduler.settled();
        // The run's own write re-plans (the store's onChange): still the next slot, never the one that fired.
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: utc(5, 5) });
        expect(t.armed()).toEqual([utc(5, 5)]);

        // What a real timer does next: wall time passes the slot, and nothing more fires until 05:05.
        t.runUntil(utc(5, 4, 30));
        await scheduler.settled();
        expect(runs).toBe(1);
        expect(store.get(flow.id)!.runs).toHaveLength(1);
    });

    it('EARLY by a whole stalled loop turn (150 ms): still the armed slot, once', async () => {
        const t = handTimer();
        let runs = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async () => { runs += 1; } });
        const flow = await armed('minutely', '* * * * *');
        scheduler.plan();
        t.wake(utc(5, 4) - 150);
        await scheduler.settled();
        t.runUntil(utc(5, 4, 59, 999));
        await scheduler.settled();
        expect(runs).toBe(1);
        expect(store.get(flow.id)!.runs.map((r) => r.outcome)).toEqual(['ran']);
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: utc(5, 5) });
    });

    it('an early fire while the previous run is still going records NO held run beside it: one slot, one record', async () => {
        const t = handTimer();
        let release!: () => void;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: () => new Promise<void>((r) => { release = r; }) });
        const flow = await armed('minutely', '* * * * *');
        scheduler.plan();
        t.wake(utc(5, 4) - 1);
        // Wall time reaches the slot while the run is still going.
        t.runUntil(utc(5, 4, 0, 5));
        release();
        await scheduler.settled();
        expect(store.get(flow.id)!.runs.map((r) => r.outcome)).toEqual(['ran']);
    });

    it('LATE by 30 s: the slot runs once and the next plan is the FOLLOWING slot — not the one that fired, and not one skipped', async () => {
        const t = handTimer();
        let runs = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async () => { runs += 1; } });
        const flow = await armed('minutely', '* * * * *');
        scheduler.plan();
        t.wake(utc(5, 4, 30));
        await scheduler.settled();
        expect(runs).toBe(1);
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: utc(5, 5) });
        // The control that "never again" did not become "never": 05:05 fires and runs.
        t.runUntil(utc(5, 5));
        await scheduler.settled();
        expect(runs).toBe(2);
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: utc(5, 6) });
    });

    it('LATE past the next slot (the machine slept): the armed slot runs once, the missed one is not caught up, the plan goes forward from now', async () => {
        const t = handTimer();
        let runs = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async () => { runs += 1; } });
        const flow = await armed('minutely', '* * * * *');
        scheduler.plan();
        t.wake(utc(5, 9, 10));
        await scheduler.settled();
        expect(runs).toBe(1);
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: utc(5, 10) });
    });

    it('the wall clock SET BACK after a fire (an NTP step, by hand): the slot that ran does not run again', async () => {
        const t = handTimer();
        let runs = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async () => { runs += 1; } });
        const flow = await armed('nightly', '0 3 * * *');
        clock = Date.UTC(2026, 9, 11, 2, 59, 30);
        scheduler.plan();
        const slot = Date.UTC(2026, 9, 11, 3, 0);
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: slot });
        t.wake(slot + 20);
        await scheduler.settled();
        // The clock steps back two minutes, and anything re-plans (an edit, a disarm and arm again, the next write).
        clock = slot - 2 * 60_000;
        scheduler.plan();
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: Date.UTC(2026, 9, 12, 3, 0) });
        t.runUntil(slot + 60_000);
        await scheduler.settled();
        expect(runs).toBe(1);
    });

    it('the slot guard is per flow: a flow armed in the early-fire window that has NOT run at that slot still runs at it', async () => {
        const t = handTimer();
        const ran: string[] = [];
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async (flow) => { ran.push(flow.name); } });
        await armed('first', '* * * * *');
        scheduler.plan();
        t.wake(utc(5, 4) - 1);
        await scheduler.settled();
        // Armed while the wall still reads before 05:04: 05:04 is its own first slot.
        const second = await armed('second', '* * * * *');
        expect(scheduler.nextDue()?.at).toBe(utc(5, 4));
        t.runUntil(utc(5, 4, 0, 1));
        await scheduler.settled();
        expect(ran).toEqual(['first', 'second']);
        expect(store.get(second.id)!.runs).toHaveLength(1);
        expect(scheduler.nextDue()?.at).toBe(utc(5, 5));
    });

    it('the wall clock MOVED FORWARD before the fire (the timer still wakes on its own clock): the armed slot runs once, the plan goes forward from the new reading', async () => {
        const t = handTimer();
        let runs = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async () => { runs += 1; } });
        const flow = await armed('minutely', '* * * * *');
        scheduler.plan();
        t.wake(utc(7, 0, 0, 400));
        await scheduler.settled();
        expect(runs).toBe(1);
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: utc(7, 1) });
    });

    it('DST spring forward (New York, 8 March): 02:30 runs at 03:30 EDT; an early wake there runs it once and plans 02:30 the next day', async () => {
        const t = handTimer();
        let runs = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async () => { runs += 1; } });
        const flow = await armed('spring', '30 2 * * *', 'America/New_York');
        const slot = Date.parse('2026-03-08T07:30:00Z');
        clock = slot - 400;
        scheduler.plan();
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: slot });
        t.wake(slot - 1);
        await scheduler.settled();
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: Date.parse('2026-03-09T06:30:00Z') });
        t.runUntil(slot + 60_000);
        await scheduler.settled();
        expect(runs).toBe(1);
    });

    it('DST fall back (New York, 1 November): 01:30 happens twice; an early wake at the first runs it once and plans the NEXT DAY, not the repeated hour', async () => {
        const t = handTimer();
        let runs = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: t.schedule, run: async () => { runs += 1; } });
        const flow = await armed('autumn', '30 1 * * *', 'America/New_York');
        const first = Date.parse('2026-11-01T05:30:00Z'); // 01:30 EDT
        clock = first - 400;
        scheduler.plan();
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: first });
        t.wake(first - 1);
        await scheduler.settled();
        expect(scheduler.nextDue()).toEqual({ flowId: flow.id, at: Date.parse('2026-11-02T06:30:00Z') });
        // Through the repeated hour (06:30Z = 01:30 EST): nothing more.
        t.runUntil(Date.parse('2026-11-01T06:31:00Z'));
        await scheduler.settled();
        expect(runs).toBe(1);
    });
});
