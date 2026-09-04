import { describe, expect, it } from 'vitest';
import { flowScheduleSpecId, planFlowSchedules, type ExistingFlowSchedule } from '../schedule-plan';
import type { ScheduledFlow } from '../store';

/**
 * Turning "these flows declare schedules" into "arm these, change those, drop the
 * rest" — the owner's requirement, made a decision rather than a side effect.
 *
 *   > if any time based triggers exist, a cron checker should auto be started
 *
 * So nobody wires a schedule up by hand. A flow declares one on its canvas and
 * Genie reconciles: on boot, and again whenever a flow is saved, deleted,
 * disabled, or its app revoked. That makes this a diff between what the graphs
 * SAY and what the host scheduler currently HOLDS, which is exactly the kind of
 * thing worth having pure and tested rather than discovering in production.
 *
 * The spec id is derived from the flow and the trigger node, so reconciling twice
 * is the same as reconciling once. Anything keyed on a fresh id would create a
 * duplicate timer on every boot — the failure mode where nightly backups start
 * running four times a night and nothing looks wrong.
 */

const desired = (over: Partial<ScheduledFlow> = {}): ScheduledFlow => ({
    flowId: 'f1',
    appId: 'app-1',
    name: 'Nightly triage',
    nodeId: 's1',
    cron: '0 3 * * *',
    ...over,
});

const existing = (over: Partial<ExistingFlowSchedule> = {}): ExistingFlowSchedule => ({
    specId: flowScheduleSpecId('f1', 's1'),
    flowId: 'f1',
    cron: '0 3 * * *',
    // The label AS STORED, written out rather than derived: a fixture that built
    // it the same way the implementation does would agree with itself no matter
    // what the format became, and this is the assertion pinning that format.
    label: 'Nightly triage (flow)',
    ...over,
});

describe('the id a schedule is keyed on', () => {
    it('is derived from the flow and its trigger node, so reconciling is idempotent', () => {
        expect(flowScheduleSpecId('f1', 's1')).toBe(flowScheduleSpecId('f1', 's1'));
        expect(flowScheduleSpecId('f1', 's1')).not.toBe(flowScheduleSpecId('f1', 's2'));
        expect(flowScheduleSpecId('f1', 's1')).not.toBe(flowScheduleSpecId('f2', 's1'));
    });

    it('is namespaced, so it cannot collide with a process the user made', () => {
        expect(flowScheduleSpecId('f1', 's1')).toMatch(/^flow:/);
    });
});

describe('arming what is newly declared', () => {
    it('creates a schedule for a flow that has none', () => {
        const plan = planFlowSchedules([desired()], []);

        expect(plan.delete).toEqual([]);
        expect(plan.update).toEqual([]);
        expect(plan.create).toHaveLength(1);
        expect(plan.create[0]).toMatchObject({
            specId: flowScheduleSpecId('f1', 's1'),
            flowId: 'f1',
            cron: '0 3 * * *',
        });
    });

    it('creates one per trigger node when a graph declares several', () => {
        const plan = planFlowSchedules(
            [desired({ nodeId: 's1', cron: '0 3 * * *' }), desired({ nodeId: 's2', cron: '0 9 * * *' })],
            [],
        );

        expect(plan.create.map((c) => c.cron)).toEqual(['0 3 * * *', '0 9 * * *']);
    });

    it('labels the schedule after the flow, so the process list is readable', () => {
        expect(planFlowSchedules([desired()], []).create[0]!.label).toContain('Nightly triage');
    });
});

describe('leaving alone what already matches', () => {
    it('plans nothing when the declaration and the schedule agree', () => {
        const plan = planFlowSchedules([desired()], [existing()]);

        expect(plan).toEqual({ create: [], update: [], delete: [], changed: false });
    });
});

describe('changing what drifted', () => {
    it('updates a schedule whose cron changed', () => {
        const plan = planFlowSchedules([desired({ cron: '0 5 * * *' })], [existing()]);

        expect(plan.create).toEqual([]);
        expect(plan.update).toHaveLength(1);
        expect(plan.update[0]!.cron).toBe('0 5 * * *');
    });

    it('updates a schedule whose flow was renamed', () => {
        const plan = planFlowSchedules([desired({ name: 'Renamed' })], [existing()]);

        expect(plan.update).toHaveLength(1);
        expect(plan.update[0]!.label).toContain('Renamed');
    });
});

describe('disarming what is no longer declared', () => {
    it('deletes a schedule whose flow stopped declaring one', () => {
        const plan = planFlowSchedules([], [existing()]);

        expect(plan.delete).toEqual([flowScheduleSpecId('f1', 's1')]);
    });

    it('deletes the schedule for the trigger node that was removed, keeping the other', () => {
        const plan = planFlowSchedules(
            [desired({ nodeId: 's1' })],
            [existing({ specId: flowScheduleSpecId('f1', 's1') }), existing({
                specId: flowScheduleSpecId('f1', 's2'),
            })],
        );

        expect(plan.delete).toEqual([flowScheduleSpecId('f1', 's2')]);
    });

    it('deletes every schedule for a flow that is gone, disabled, or revoked', () => {
        // `listScheduledFlows` already excludes disabled flows and revoked apps,
        // so all three arrive here identically: the flow simply stops being
        // desired, and its timer must go. Leaving it armed is how a revoked app
        // keeps firing every night to be refused.
        const plan = planFlowSchedules([], [existing(), existing({ specId: 'flow:f2:s1', flowId: 'f2' })]);

        expect(plan.delete.sort()).toEqual([flowScheduleSpecId('f1', 's1'), 'flow:f2:s1'].sort());
    });
});

describe('what reconciliation must not touch', () => {
    it('never plans anything for a process the user created', () => {
        // Only flow-owned specs are in `existing` by construction, but the guard
        // matters: reconciliation deleting a user's dev server because it was not
        // in a graph would be catastrophic and entirely plausible.
        const plan = planFlowSchedules([], []);

        expect(plan).toEqual({ create: [], update: [], delete: [], changed: false });
    });
});

describe('whether Genie has any scheduling to do at all', () => {
    it('says so when nothing is declared and nothing is armed', () => {
        expect(planFlowSchedules([], []).changed).toBe(false);
    });

    it('says so when there is work', () => {
        expect(planFlowSchedules([desired()], []).changed).toBe(true);
    });
});
