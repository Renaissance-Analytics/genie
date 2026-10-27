import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nextCronAfter, timeZoneProblem } from '../src/core/cron.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { createFlowRunner } from '../src/main/flow-runner.js';
import { FlowScheduler, type RunResult } from '../src/main/flow-scheduler.js';
import { FlowStore, RUN_HISTORY_LIMIT, type Actor, type FlowRecord } from '../src/main/flow-store.js';

/**
 * FLOWS (§6.6) — scheduled and repeating work on fancy-flow. Genie's half: the store (**an agent
 * can create a flow but never arm one**; refusals are named on the canvas with the reason), the
 * cron evaluator, and a scheduler that holds ONE timer to the nearest due — never a poll.
 */

const agent: Actor = { kind: 'agent', id: 'agent_a', name: 'atlas' };
const user: Actor = { kind: 'user' };

const doc = (cron = '*/5 * * * *') => ({
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

    it('an IANA zone is evaluated on THAT zone’s wall clock; a zone the platform does not know is refused as null, never read as UTC', () => {
        // 09:00 in Amsterdam on 11 October (summer time, UTC+2) is 07:00 UTC.
        expect(nextCronAfter('0 9 * * *', at('2026-10-11T05:03:00Z'), 'Europe/Amsterdam')).toBe(at('2026-10-11T07:00:00Z'));
        expect(nextCronAfter('0 9 * * *', at('2026-10-11T05:03:00Z'), 'Mars/Olympus_Mons')).toBeNull();
        expect(timeZoneProblem('Mars/Olympus_Mons')).toMatch(/Mars\/Olympus_Mons is not one Genie knows/);
        expect(timeZoneProblem('Europe/Amsterdam')).toBeNull();
        expect(timeZoneProblem(undefined)).toBeNull();
    });
});

/**
 * LOCAL TIME (hosting ship line P4). Genie 1 evaluated every schedule in the machine's local time; Genie 2 was
 * UTC-only, so a 09:00 job ran at the wrong hour all year and moved by an hour twice a year. No timezone now
 * means local time, and both daylight-saving changes keep Genie 1's rule: a daily job runs once a day at its
 * wall-clock time, a time in the spring gap runs just after the jump, a time in the autumn repeat runs once.
 *
 * The machine's zone is set to New York for this block (Node re-reads TZ when it is assigned), with a positive
 * control that it took — on a UTC test machine the local-time assertions would otherwise prove nothing.
 */
describe('cron — this machine’s local time, across daylight saving', () => {
    const at = (iso: string) => Date.parse(iso);
    let saved: string | undefined;
    beforeAll(() => {
        saved = process.env.TZ;
        process.env.TZ = 'America/New_York';
    });
    afterAll(() => {
        if (saved === undefined) delete process.env.TZ;
        else process.env.TZ = saved;
    });

    it('control: the machine’s local clock really is New York here (13:00 UTC on 11 October reads 09:00)', () => {
        expect(new Date(at('2026-10-11T13:00:00Z')).getHours()).toBe(9);
    });

    it('no timezone = local time, not UTC: 09:00 daily is 13:00 UTC in New York summer time; an explicit UTC is still UTC', () => {
        expect(nextCronAfter('0 9 * * *', at('2026-10-11T05:03:00Z'), undefined)).toBe(at('2026-10-11T13:00:00Z'));
        expect(nextCronAfter('0 9 * * *', at('2026-10-11T05:03:00Z'), 'UTC')).toBe(at('2026-10-11T09:00:00Z'));
    });

    // The same four facts through the machine's local clock (no timezone) and through the named zone (Intl).
    for (const [label, zone] of [['local (no timezone)', undefined], ['named America/New_York', 'America/New_York']] as const) {
        describe(label, () => {
            it('a daily 09:00 keeps 09:00 across the autumn change: 13:00 UTC on 31 October, then 14:00 UTC on 1 November', () => {
                expect(nextCronAfter('0 9 * * *', at('2026-10-31T13:00:00Z'), zone)).toBe(at('2026-11-01T14:00:00Z'));
            });

            it('a daily 09:00 keeps 09:00 across the spring change: 14:00 UTC on 7 March, then 13:00 UTC on 8 March', () => {
                expect(nextCronAfter('0 9 * * *', at('2026-03-07T14:00:00Z'), zone)).toBe(at('2026-03-08T13:00:00Z'));
            });

            it('02:30 does not exist on 8 March (02:00 jumps to 03:00): it runs at 03:30 that day, then 02:30 again the next', () => {
                const gap = nextCronAfter('30 2 * * *', at('2026-03-07T08:00:00Z'), zone);
                expect(gap).toBe(at('2026-03-08T07:30:00Z'));
                expect(nextCronAfter('30 2 * * *', gap!, zone)).toBe(at('2026-03-09T06:30:00Z'));
            });

            it('and it still runs at 03:30 when the schedule is planned AFTER the jump but before 03:30 (a launch, an edit at 03:10)', () => {
                // Found by the Flows acceptance suite: the walk began at the wall reading of "now" (03:10), past 02:30, so
                // the day's run was lost to tomorrow whenever Genie planned between the jump and the run.
                expect(nextCronAfter('30 2 * * *', at('2026-03-08T07:10:00Z'), zone)).toBe(at('2026-03-08T07:30:00Z'));
                expect(nextCronAfter('30 2 * * *', at('2026-03-08T07:29:59.600Z'), zone)).toBe(at('2026-03-08T07:30:00Z'));
                // CONTROL: a plan after 03:30 that day is tomorrow's 02:30.
                expect(nextCronAfter('30 2 * * *', at('2026-03-08T07:30:00Z'), zone)).toBe(at('2026-03-09T06:30:00Z'));
            });

            it('01:30 happens twice on 1 November: it runs at the first only, then 01:30 the next day — once a day, COUNTED', () => {
                const first = nextCronAfter('30 1 * * *', at('2026-10-31T06:00:00Z'), zone);
                expect(first).toBe(at('2026-11-01T05:30:00Z'));
                const next = nextCronAfter('30 1 * * *', first!, zone);
                expect(next).toBe(at('2026-11-02T06:30:00Z'));
                // Exactly one run on 1 November local: the second 01:30 (06:30 UTC) is not one.
                expect(next).not.toBe(at('2026-11-01T06:30:00Z'));
            });
        });
    }
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
        await expect(store.create({ workspaceId: 'tynn', name: 'bad', document: { version: 2, graph: { nodes: [], edges: [] } }, by: user })).rejects.toThrow(/version/);
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

/**
 * THE ENGINE READS EVERY STEP. The store validated documents with fancy-flow's `importWorkflow`, which reads steps
 * from `graph.nodes` — and Genie wrote them at the top level, so ZERO nodes were validated and every document passed.
 * Now a step missing the config its kind requires, or of a kind nobody registered, is refused at create with the
 * engine's words; a document in the old shape is migrated, not kept beside the new one.
 */
describe('the store refuses what the engine refuses — every step read', () => {
    const trigger = { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } };
    const withStep = (step: Record<string, unknown>) => ({
        $schema: FLOW_SCHEMA_URL,
        version: 1,
        graph: { nodes: [trigger, { id: 's', position: { x: 240, y: 0 }, ...step }], edges: [{ id: 'e1', source: 't', target: 's' }] },
    });
    /** The same document as earlier betas (and an agent sending the old shape) wrote it. */
    const oldShape = (step: Record<string, unknown>) => ({ version: 1, nodes: [trigger, { id: 's', position: { x: 240, y: 0 }, ...step }], edges: [{ id: 'e1', source: 't', target: 's' }] });

    it('a step lacking its REQUIRED config is refused with the engine’s words, in either shape — counted: four refused, nothing stored; control: the complete one is accepted', async () => {
        const incomplete = [
            withStep({ kind: 'genie/terminal_run', config: { workspace: 'tynn' } }),
            oldShape({ kind: 'genie/terminal_run', config: { workspace: 'tynn', command: '' } }),
            withStep({ kind: 'genie/agent_prompt', config: { prompt: 'post the standup' } }),
            oldShape({ kind: 'genie/agent_prompt', config: { prompt: 'post the standup' } }),
        ];
        const outcomes = await Promise.all(incomplete.map((document) => store.create({ workspaceId: 'tynn', name: 'incomplete', document, by: agent }).then(() => 'accepted', (e: Error) => e.message)));
        expect(outcomes).toEqual([
            'the flow document was refused by the engine: node s: command: Command is required',
            'the flow document was refused by the engine: node s: command: Command is required',
            'the flow document was refused by the engine: node s: agent: Agent is required',
            'the flow document was refused by the engine: node s: agent: Agent is required',
        ]);
        expect(store.list()).toEqual([]);

        await store.create({ workspaceId: 'tynn', name: 'complete', document: withStep({ kind: 'genie/terminal_run', config: { workspace: 'tynn', command: 'npm run report' } }), by: agent });
        expect(store.list().map((f) => f.name)).toEqual(['complete']);
    });

    it('a kind nobody registered is refused as unknown; nothing is stored', async () => {
        await expect(store.create({ workspaceId: 'tynn', name: 'odd', document: oldShape({ kind: 'genie/no_such_kind', config: {} }), by: agent })).rejects.toThrow(
            'the flow document was refused by the engine: node s: Unknown kind "genie/no_such_kind" — register it before importing.',
        );
        expect(store.list()).toEqual([]);
    });

    it('an update is held to the same rule: an incomplete step is refused and the flow keeps its document', async () => {
        const f = await store.create({ workspaceId: 'tynn', name: 'tick', document: doc(), by: user });
        await expect(store.update(f.id, { document: withStep({ kind: 'genie/agent_prompt', config: { agent: 'claude:atlas' } }) }, user)).rejects.toThrow(/node s: prompt: Prompt is required/);
        expect(store.get(f.id)!.document).toEqual(doc());
    });

    it('a document sent in the OLD shape is stored in the canonical one — never both', async () => {
        const f = await store.create({ workspaceId: 'tynn', name: 'old', document: oldShape({ kind: 'log', config: { message: 'tick' } }), by: agent });
        expect(f.document).toEqual(withStep({ kind: 'log', config: { message: 'tick' } }));
        expect(f.document).not.toHaveProperty('nodes');
        expect(store.schedules(f.id)).toEqual([{ nodeId: 't', cron: '0 3 * * *', timezone: undefined }]);
    });

    it('a flows.json from an earlier beta is MIGRATED on open — written back in the graph shape — and its flow still RUNS, counted once', async () => {
        const { readFile, writeFile, mkdir } = await import('node:fs/promises');
        const legacy = {
            id: 'flow_legacy',
            workspaceId: 'tynn',
            name: 'nightly report',
            document: oldShape({ kind: 'genie/terminal_run', config: { workspace: 'tynn', command: 'npm run report' } }),
            armed: true,
            createdBy: { kind: 'user' },
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
            refusals: [],
            runs: [],
        };
        await mkdir(join(dir, 'runtime'), { recursive: true });
        await writeFile(join(dir, 'runtime', 'flows.json'), JSON.stringify({ flows: [legacy] }));

        const reopened = await FlowStore.open(dir, now);
        const migrated = reopened.get('flow_legacy')!;
        expect(migrated.document).toEqual(withStep({ kind: 'genie/terminal_run', config: { workspace: 'tynn', command: 'npm run report' } }));
        const onDisk = JSON.parse(await readFile(join(dir, 'runtime', 'flows.json'), 'utf8')) as { flows: Array<{ document: Record<string, unknown> }> };
        expect(onDisk.flows[0]!.document).toEqual(migrated.document);
        expect(onDisk.flows[0]!.document).not.toHaveProperty('nodes');
        expect(reopened.schedules('flow_legacy')).toEqual([{ nodeId: 't', cron: '0 3 * * *', timezone: undefined }]);

        const calls: unknown[][] = [];
        const ports: FlowPorts = {
            promptAgent: async () => '',
            runCommand: async (workspaceId, command, cwd) => { calls.push([workspaceId, command, cwd]); return { exitCode: 0, output: '' }; },
            addKnowledge: async () => ({ id: 'kn_1' }),
        };
        const result = await createFlowRunner({ ports: () => ports, asleep: () => false, now })(migrated, { nodeId: 't', cron: '0 3 * * *', timezone: undefined });
        expect(result).toEqual({ outcome: 'ran' });
        expect(calls).toEqual([['tynn', 'npm run report', undefined]]);
    });

    it('a flow an earlier beta accepted that the engine now refuses is KEPT, and its run FAILS in the engine’s words before any step runs', async () => {
        const { writeFile, mkdir } = await import('node:fs/promises');
        const accepted = { id: 'flow_hollow', workspaceId: 'tynn', name: 'hollow', document: oldShape({ kind: 'genie/terminal_run', config: { workspace: 'tynn' } }), armed: true, createdBy: { kind: 'user' }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', refusals: [], runs: [] };
        await mkdir(join(dir, 'runtime'), { recursive: true });
        await writeFile(join(dir, 'runtime', 'flows.json'), JSON.stringify({ flows: [accepted] }));
        const reopened = await FlowStore.open(dir, now);
        expect(reopened.list().map((f) => f.id)).toEqual(['flow_hollow']);
        let ran = 0;
        const ports: FlowPorts = { promptAgent: async () => '', runCommand: async () => { ran += 1; return { exitCode: 0, output: '' }; }, addKnowledge: async () => ({ id: 'kn_1' }) };
        expect(await createFlowRunner({ ports: () => ports, asleep: () => false, now })(reopened.get('flow_hollow')!, null)).toEqual({
            outcome: 'failed',
            reason: 'the flow document was refused by the engine: node s: command: Command is required',
        });
        expect(ran).toBe(0);
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

    it('a run that throws is recorded on the flow as FAILED with the error’s words, and does not stop the next schedule', async () => {
        const fc = fakeClock();
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: async () => { throw new Error('executor exploded'); } });
        const f = await store.create({ workspaceId: 'tynn', name: 'every5', document: doc(), by: user, armed: true });
        scheduler.plan();
        fc.advanceTo(Date.UTC(2026, 9, 11, 5, 5, 0));
        await scheduler.settled();
        expect(store.get(f.id)!.runs).toEqual([{ at: '2026-10-11T05:05:00.000Z', endedAt: '2026-10-11T05:05:00.000Z', trigger: 'schedule', outcome: 'failed', reason: 'executor exploded' }]);
        expect(fc.pending()).toBe(1);
    });
});

/**
 * SCHEDULED TASKS ACTUALLY RUN (hosting ship line P4). The scheduler hands a due ARMED flow to its runner — once
 * per due, never for a disarmed flow — and records what the runner answered: ran, failed with the reason, or held
 * back with why. The person's Run now does the same for one flow, armed or not. A flow never runs twice at once.
 */
describe('runs and their outcomes', () => {
    function fakeClock() {
        const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
        return {
            schedule(fn: () => void, ms: number) {
                const t = { at: clock + ms, fn, cancelled: false };
                timers.push(t);
                return () => { t.cancelled = true; };
            },
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

    it('a due ARMED flow runs ONCE per due — counted across two dues — and a DISARMED flow on the same schedule never runs', async () => {
        const fc = fakeClock();
        const ran = new Map<string, number>();
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: async (flow) => { ran.set(flow.name, (ran.get(flow.name) ?? 0) + 1); } });
        const armed = await store.create({ workspaceId: 'tynn', name: 'armed', document: doc('*/5 * * * *'), by: user, armed: true });
        await store.create({ workspaceId: 'tynn', name: 'disarmed', document: doc('*/5 * * * *'), by: user });
        scheduler.plan();

        fc.advanceTo(Date.UTC(2026, 9, 11, 5, 5, 0));
        await scheduler.settled();
        expect(ran.get('armed')).toBe(1);
        fc.advanceTo(Date.UTC(2026, 9, 11, 5, 10, 0));
        await scheduler.settled();
        expect(ran.get('armed')).toBe(2);
        expect(ran.get('disarmed')).toBeUndefined();
        expect(store.get(armed.id)!.runs.map((r) => [r.at, r.trigger, r.outcome])).toEqual([
            ['2026-10-11T05:05:00.000Z', 'schedule', 'ran'],
            ['2026-10-11T05:10:00.000Z', 'schedule', 'ran'],
        ]);
    });

    it('records what the runner answered: failed WITH its reason, held back WITH why — a run that answers nothing ran', async () => {
        const fc = fakeClock();
        const answers: Array<RunResult | void> = [{ outcome: 'failed', reason: 'npm test ended with exit code 1' }, { outcome: 'held', reason: 'atlas is busy (mid-turn); the prompt was not delivered' }, undefined];
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: async () => answers.shift() });
        const f = await store.create({ workspaceId: 'tynn', name: 'every5', document: doc(), by: user, armed: true });
        scheduler.plan();
        for (const m of [5, 10, 15]) {
            fc.advanceTo(Date.UTC(2026, 9, 11, 5, m, 0));
            await scheduler.settled();
        }
        expect(store.get(f.id)!.runs.map((r) => ({ outcome: r.outcome, reason: r.reason }))).toEqual([
            { outcome: 'failed', reason: 'npm test ended with exit code 1' },
            { outcome: 'held', reason: 'atlas is busy (mid-turn); the prompt was not delivered' },
            { outcome: 'ran', reason: undefined },
        ]);
    });

    it('never two copies: a flow still running when it is due again is HELD back and says so; the first run still lands', async () => {
        const fc = fakeClock();
        let release: () => void = () => {};
        let started = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: () => { started += 1; return new Promise<void>((r) => { release = r; }); } });
        const f = await store.create({ workspaceId: 'tynn', name: 'slow', document: doc(), by: user, armed: true });
        scheduler.plan();
        fc.advanceTo(Date.UTC(2026, 9, 11, 5, 5, 0));
        expect(scheduler.inFlightCount()).toBe(1);
        // The second due records its hold (the store's write is the signal) without starting anything.
        await new Promise<void>((recorded) => {
            const off = store.onChange(() => { off(); recorded(); });
            fc.advanceTo(Date.UTC(2026, 9, 11, 5, 10, 0));
        });
        expect(started).toBe(1);
        // The person's Run now meets the same guard.
        expect(await scheduler.runNow(f.id)).toMatchObject({ trigger: 'manual', outcome: 'held' });
        expect(started).toBe(1);
        expect(store.get(f.id)!.runs[0]).toMatchObject({ trigger: 'schedule', outcome: 'held', reason: 'the previous run of "slow" is still going; this one was not started beside it' });
        release();
        await scheduler.settled();
        expect(store.get(f.id)!.runs.map((r) => r.outcome)).toEqual(['held', 'held', 'ran']);
        expect(scheduler.inFlightCount()).toBe(0);
    });

    it('Run now: one run of a DISARMED flow, from its schedule trigger, recorded as manual; the schedule stays disarmed; an unknown flow is refused', async () => {
        const fc = fakeClock();
        const triggers: unknown[] = [];
        const scheduler = new FlowScheduler({ store, now, schedule: fc.schedule, run: async (_flow, trigger) => { triggers.push(trigger); } });
        const f = await store.create({ workspaceId: 'tynn', name: 'by hand', document: doc('0 3 * * *'), by: user });
        const run = await scheduler.runNow(f.id);
        expect(run).toEqual({ at: '2026-10-11T05:03:00.000Z', endedAt: '2026-10-11T05:03:00.000Z', trigger: 'manual', outcome: 'ran' });
        expect(triggers).toEqual([{ nodeId: 't', cron: '0 3 * * *', timezone: 'UTC' }]);
        expect(store.get(f.id)!.armed).toBe(false);
        expect(scheduler.nextDue()).toBeNull();
        await expect(scheduler.runNow('flow_missing')).rejects.toThrow(/no flow flow_missing/);
    });

    it(`the history is BOUNDED: after ${RUN_HISTORY_LIMIT + 5} runs the flow keeps the last ${RUN_HISTORY_LIMIT}, oldest dropped first`, async () => {
        let n = 0;
        const scheduler = new FlowScheduler({ store, now, schedule: () => () => {}, run: async () => ({ outcome: 'failed', reason: `run ${++n}` }) });
        const f = await store.create({ workspaceId: 'tynn', name: 'busy', document: doc(), by: user });
        for (let i = 0; i < RUN_HISTORY_LIMIT + 5; i++) await scheduler.runNow(f.id);
        const runs = store.get(f.id)!.runs;
        expect(runs).toHaveLength(RUN_HISTORY_LIMIT);
        expect(runs[0]!.reason).toBe('run 6');
        expect(runs.at(-1)!.reason).toBe(`run ${RUN_HISTORY_LIMIT + 5}`);
        // ...and the bound survives a restart.
        expect((await FlowStore.open(dir, now)).get(f.id)!.runs).toHaveLength(RUN_HISTORY_LIMIT);
    });

    it('a flows.json from before run history reads with an empty history — the old lastRun (nothing ever executed) is not carried', async () => {
        const f = await store.create({ workspaceId: 'tynn', name: 'old', document: doc(), by: user });
        const { writeFile } = await import('node:fs/promises');
        const legacy = { ...(store.get(f.id) as FlowRecord & Record<string, unknown>), lastRun: { at: '2026-10-01T00:00:00.000Z', ok: true } } as Record<string, unknown>;
        delete legacy.runs;
        await writeFile(join(dir, 'runtime', 'flows.json'), JSON.stringify({ flows: [legacy] }));
        const reopened = await FlowStore.open(dir, now);
        expect(reopened.get(f.id)!.runs).toEqual([]);
        expect(reopened.get(f.id)).not.toHaveProperty('lastRun');
    });
});
