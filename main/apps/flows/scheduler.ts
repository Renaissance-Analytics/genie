/**
 * Making the host scheduler hold exactly what the graphs declare.
 *
 * The owner's rule:
 *
 *   > Ops running should not be tied to an agent request unless it's a manual
 *   > trigger… if any time based triggers exist, a cron checker should auto be
 *   > started.
 *
 * So this runs on boot and after every change to a flow, and nobody wires a
 * schedule up by hand. What to do is decided by {@link planFlowSchedules}, which
 * is pure and tested; this file is the part that touches the database and the
 * timers, and is deliberately boring: plan, apply, arm.
 *
 * ## It only ever owns `flow:` specs
 *
 * Reconciliation reads and writes scheduled tasks whose id carries the
 * {@link FLOW_SCHEDULE_PREFIX}. A process the user created is invisible to it.
 * Without that separation, "delete everything not mentioned in a graph" would
 * eventually delete somebody's dev server, and the code that did it would look
 * perfectly reasonable.
 *
 * ## A flow spec carries no command
 *
 * `schedule_kind: 'flow'` fires through the scheduler's own flow branch, so there
 * is nothing to spawn. Leaving `command` unset is what makes a flow spec unable
 * to run a shell even if something later mistook it for a command task.
 */

import {
    createTerminalSpec,
    deleteTerminalSpec,
    getAppGrant,
    listTerminalSpecs,
    updateTerminalSpec,
    type TerminalSpecRow,
} from '../../db';
import { armSchedule, disarmSchedule, forgetSchedule } from '../../terminal/process-scheduler';
import {
    FLOW_SCHEDULE_PREFIX,
    planFlowSchedules,
    type ExistingFlowSchedule,
    type FlowScheduleSpec,
} from './schedule-plan';
import { listScheduledFlows, type ScheduledFlow } from './store';

/** The flow-owned scheduled tasks currently in the database. */
function existingFlowSchedules(specs: readonly TerminalSpecRow[]): ExistingFlowSchedule[] {
    return specs
        .filter(
            (s) =>
                s.id.startsWith(FLOW_SCHEDULE_PREFIX) &&
                s.type === 'process' &&
                s.meta?.schedule_kind === 'flow',
        )
        .map((s) => ({
            specId: s.id,
            flowId: typeof s.meta?.flow_id === 'string' ? s.meta.flow_id : '',
            cron: typeof s.meta?.schedule === 'string' ? s.meta.schedule : '',
            label: s.label,
        }));
}

/** Where a flow's scheduled task is filed — its app's workspace. */
function workspaceForFlow(desired: readonly ScheduledFlow[], flowId: string): string | null {
    const flow = desired.find((d) => d.flowId === flowId);
    return flow ? (getAppGrant(flow.appId)?.workspaceId ?? null) : null;
}

function applyCreate(spec: FlowScheduleSpec, workspaceId: string | null): void {
    createTerminalSpec({
        id: spec.specId,
        workspace_id: workspaceId,
        label: spec.label,
        cwd: '',
        type: 'process',
        meta: {
            schedule: spec.cron,
            schedule_kind: 'flow',
            flow_id: spec.flowId,
        },
    });
    armSchedule(spec.specId);
}

function applyUpdate(spec: FlowScheduleSpec): void {
    updateTerminalSpec(spec.specId, {
        label: spec.label,
        meta: { schedule: spec.cron, schedule_kind: 'flow', flow_id: spec.flowId },
    });
    // Re-arm so the timer moves to the NEW expression. Arming an already-armed
    // spec replaces its timer; leaving it would keep firing on the old schedule
    // while the UI showed the new one.
    armSchedule(spec.specId);
}

function applyDelete(specId: string): void {
    disarmSchedule(specId);
    forgetSchedule(specId);
    deleteTerminalSpec(specId);
}

/**
 * Reconcile every flow schedule. Safe to call as often as you like — the plan is
 * a diff, and the spec ids are derived, so repeating it changes nothing.
 *
 * Returns whether anything actually changed, which is only useful for logging.
 */
export function reconcileFlowSchedules(): boolean {
    const desired = listScheduledFlows();
    const plan = planFlowSchedules(desired, existingFlowSchedules(listTerminalSpecs()));
    if (!plan.changed) return false;

    for (const specId of plan.delete) applyDelete(specId);
    for (const spec of plan.create) applyCreate(spec, workspaceForFlow(desired, spec.flowId));
    for (const spec of plan.update) applyUpdate(spec);

    return true;
}
