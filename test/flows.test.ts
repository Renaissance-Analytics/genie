import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextCronAfter } from '../src/core/cron.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore, type Actor } from '../src/main/flow-store.js';

/**
 * FLOWS (§6.6) — scheduled and repeating work on fancy-flow. Genie's half: the store (**an agent
 * can create a flow but never arm one**; refusals are named on the canvas with the reason), the
 * cron evaluator, and a scheduler that holds ONE timer to the nearest due — never a poll.
 */

const agent: Actor = { kind: 'agent', id: 'agent_a', name: 'atlas' };
const user: Actor = { kind: 'user' };

const doc = (cron = '*/5 * * * *') => ({
    version: 1,
    nodes: [
        { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron, timezone: 'UTC' } },
        { id: 'l', kind: 'log', position: { x: 200, y: 0 }, config: { message: 'tick' } },
    ],
    edges: [{ id: 'e1', source: 't', target: 'l' }],
});

let dir: string;
let store: FlowStore;
let clock = Date.UTC(2026, 9, 11, 5, 3, 0);
const now = () => clock;

beforeEach(async () => {
    // The clock is shared by the whole file and the scheduler tests advance it; start every test at 05:03.
    clock = Date.UTC(2026, 9, 11, 5, 3, 0);
    dir = await mkdtemp(join(tmpdir(), 'genie2-flows-'));
    store = await FlowStore.open(dir, now);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('cron — standard five fields', () => {
    const at = (iso: string) => Date.parse(iso);

    it('*/5 from 05:03 → 05:05; a Monday-09:00 rule from a Saturday → the coming Monday', () => {
        expect(nextCronAfter('*/5 * * * *', at('2026-10-11T05:03:00Z'), 'UTC')).toBe(at('2026-10-11T05:05:00Z'));
        expect(nextCronAfter('0 9 * * 1', at('2026-10-10T12:00:00Z'), 'UTC')).toBe(at('2026-10-12T09:00:00Z'));
        // Strictly AFTER: a rule that matches `from` itself fires at the next match.
        expect(nextCronAfter('*/5 * * * *', at('2026-10-11T05:05:00Z'), 'UTC')).toBe(at('2026-10-11T05:10:00Z'));
    });

    it('lists, ranges and Sunday as 0 or 7', () => {
        expect(nextCronAfter('0 8,20 * * *', at('2026-10-11T09:00:00Z'), 'UTC')).toBe(at('2026-10-11T20:00:00Z'));
        expect(nextCronAfter('30 1 * * 1-5', at('2026-10-10T00:00:00Z'), 'UTC')).toBe(at('2026-10-12T01:30:00Z'));
        expect(nextCronAfter('0 0 * * 7', at('2026-10-10T00:00:00Z'), 'UTC')).toBe(at('2026-10-11T00:00:00Z'));
        expect(nextCronAfter('0 0 * * 0', at('2026-10-10T00:00:00Z'), 'UTC')).toBe(at('2026-10-11T00:00:00Z'));
    });

    it('an invalid expression or one that can never fire is null — never a guessed time', () => {
        expect(nextCronAfter('* * *', at('2026-10-11T05:03:00Z'), 'UTC')).toBeNull();
        expect(nextCronAfter('61 * * * *', at('2026-10-11T05:03:00Z'), 'UTC')).toBeNull();
        expect(nextCronAfter('0 0 31 2 *', at('2026-10-11T05:03:00Z'), 'UTC')).toBeNull();
    });

    it('a timezone other than UTC is refused as null rather than evaluated in the wrong zone', () => {
        expect(nextCronAfter('0 9 * * *', at('2026-10-11T05:03:00Z'), 'Europe/Amsterdam')).toBeNull();
    });
});

describe('the store', () => {
    it('creates a flow from a valid version-1 document and reads it back; the agent’s flow is NOT armed, even when asked', async () => {
        const f = await store.create({ workspaceId: 'tynn', name: 'nightly tick', document: doc(), by: agent, armed: true });
        expect(f).toMatchObject({ name: 'nightly tick', workspaceId: 'tynn', armed: false, createdBy: agent });
        expect(f.id).toMatch(/^flow_/);
        expect(store.get(f.id)).toEqual(f);
        expect(store.schedules(f.id)).toEqual([{ nodeId: 't', cron: '*/5 * * * *', timezone: 'UTC' }]);
    });

    it('a document without version 1 is refused with the engine’s issues, and nothing is stored', async () => {
        await expect(store.create({ workspaceId: 'tynn', name: 'bad', document: { version: 2, nodes: [], edges: [] }, by: user })).rejects.toThrow(/version/);
        expect(store.list()).toEqual([]);
    });

    it('ARMING: a person may; an agent is refused, and the refusal is named on the canvas with who and why', async () => {
        const f = await store.create({ workspaceId: 'tynn', name: 'tick', document: doc(), by: agent });
        const refused = await store.arm(f.id, agent);
        expect(refused).toEqual({ ok: false, reason: 'an agent can create a flow but never arm one; ask the user to arm "tick"' });
        expect(store.get(f.id)!.armed).toBe(false);
        expect(store.get(f.id)!.refusals).toEqual([{ at: new Date(clock).toISOString(), by: 'atlas', action: 'arm', reason: refused.ok ? '' : refused.reason }]);

        const armed = await store.arm(f.id, user);
        expect(armed).toMatchObject({ ok: true });
        expect(store.get(f.id)!.armed).toBe(true);
        // Disarming is allowed from either side — it only ever makes less happen.
        await store.disarm(f.id, agent);
        expect(store.get(f.id)!.armed).toBe(false);
    });

    it('a document update re-validates and keeps the armed state; a flow with an invalid schedule reports it as a refusal too', async () => {
        const f = await store.create({ workspaceId: 'tynn', name: 'tick', document: doc(), by: user, armed: true });
        expect(f.armed).toBe(true);
        const updated = await store.update(f.id, { document: doc('0 9 * * 1') }, user);
        expect(updated.armed).toBe(true);
        expect(store.schedules(f.id)[0]!.cron).toBe('0 9 * * 1');

        const bad = await store.update(f.id, { document: doc('99 * * * *') }, agent);
        expect(bad.refusals.at(-1)).toMatchObject({ action: 'schedule', by: 'atlas' });
        expect(bad.refusals.at(-1)!.reason).toMatch(/99 \* \* \* \*/);
    });

    it('survives a restart, lists per workspace, and remove forgets', async () => {
        const a = await store.create({ workspaceId: 'tynn', name: 'a', document: doc(), by: user, armed: true });
        await store.create({ workspaceId: 'fancy', name: 'b', document: doc(), by: user });
        const reopened = await FlowStore.open(dir, now);
        expect(reopened.list('tynn').map((f) => [f.name, f.armed])).toEqual([['a', true]]);
        expect(reopened.list()).toHaveLength(2);
        expect(await reopened.remove(a.id)).toBe(true);
        expect(await reopened.remove(a.id)).toBe(false);
        expect(reopened.list()).toHaveLength(1);
    });
});

describe('the scheduler — one timer to the nearest due, never a poll', () => {
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

    it('with two armed flows due at different times there is exactly ONE timer, set for the earlier', async () => {
        const fc = fakeClock();
        const ran: string[] = [];
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: async (flow) => { ran.push(flow.name); } });
        await store.create({ workspaceId: 'tynn', name: 'every5', document: doc('*/5 * * * *'), by: user, armed: true });
        await store.create({ workspaceId: 'tynn', name: 'hourly', document: doc('0 * * * *'), by: user, armed: true });
        await store.create({ workspaceId: 'tynn', name: 'unarmed', document: doc('* * * * *'), by: user });
        scheduler.plan();
        expect(fc.pending()).toBe(1);
        expect(scheduler.nextDue()).toEqual({ flowId: store.list().find((f) => f.name === 'every5')!.id, at: Date.UTC(2026, 9, 11, 5, 5, 0) });

        fc.advanceTo(Date.UTC(2026, 9, 11, 5, 5, 0));
        await scheduler.settled();
        expect(ran).toEqual(['every5']);
        // Re-planned: still one timer, now for 05:10 (every5 again beats 06:00).
        expect(fc.pending()).toBe(1);
        expect(scheduler.nextDue()!.at).toBe(Date.UTC(2026, 9, 11, 5, 10, 0));
    });

    it('disarming the only armed flow cancels the timer; arming re-plans', async () => {
        const fc = fakeClock();
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: async () => {} });
        const f = await store.create({ workspaceId: 'tynn', name: 'every5', document: doc(), by: user, armed: true });
        scheduler.plan();
        expect(fc.pending()).toBe(1);
        await store.disarm(f.id, user);
        expect(fc.pending()).toBe(0);
        expect(scheduler.nextDue()).toBeNull();
        await store.arm(f.id, user);
        expect(fc.pending()).toBe(1);
    });

    it('a run that throws is recorded on the flow and does not stop the next schedule', async () => {
        const fc = fakeClock();
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: async () => { throw new Error('executor exploded'); } });
        const f = await store.create({ workspaceId: 'tynn', name: 'every5', document: doc(), by: user, armed: true });
        scheduler.plan();
        fc.advanceTo(Date.UTC(2026, 9, 11, 5, 5, 0));
        await scheduler.settled();
        expect(store.get(f.id)!.lastRun).toMatchObject({ ok: false, error: 'executor exploded' });
        expect(fc.pending()).toBe(1);
    });
});
