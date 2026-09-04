/**
 * PURE. What the host scheduler should be holding, given what the graphs declare.
 *
 * The owner's requirement, which this exists to satisfy:
 *
 *   > if any time based triggers exist, a cron checker should auto be started
 *
 * Nobody wires a schedule up by hand. A flow declares one on its canvas, and
 * Genie reconciles — on boot, and again whenever a flow is saved, deleted,
 * disabled, or its app revoked. That makes the interesting part a DIFF between
 * what the graphs say and what `manageProcess` currently holds, which is worth
 * deciding in a pure function rather than discovering in production.
 *
 * ## Genie does not grow a second cron
 *
 * `main/terminal/process-scheduler.ts` already fires scheduled tasks on the host,
 * whether or not anyone has Genie open, re-arming everything at launch. This
 * module produces the rows it should be firing; it does not time anything.
 *
 * ## Why the id is derived
 *
 * `flow:<flowId>:<nodeId>` is a pure function of the declaration, so reconciling
 * twice is the same as reconciling once. Keyed on a minted id instead, every boot
 * would add another timer for the same trigger — nightly backups quietly running
 * four times a night, with nothing anywhere looking wrong.
 *
 * The `flow:` prefix also keeps the namespace apart from processes the user
 * created. Reconciliation only ever considers specs it owns; deleting somebody's
 * dev server because it was not mentioned in a graph would be catastrophic, and
 * entirely plausible without that separation.
 */

import type { ScheduledFlow } from './store';

/** A flow-owned scheduled task, as the host scheduler should hold it. */
export interface FlowScheduleSpec {
    specId: string;
    flowId: string;
    /** The trigger node that declared it — a graph may declare several. */
    nodeId: string;
    /** 5-field cron, already validated by `armableSchedules`. */
    cron: string;
    /** What the Processes list shows. */
    label: string;
}

/** A flow-owned schedule the host scheduler currently holds. */
export interface ExistingFlowSchedule {
    specId: string;
    flowId: string;
    cron: string;
    label: string;
}

export interface FlowSchedulePlan {
    create: FlowScheduleSpec[];
    update: FlowScheduleSpec[];
    /** Spec ids to remove. */
    delete: string[];
    /** False when the scheduler is already exactly right — nothing to do. */
    changed: boolean;
}

/** The `flow:` prefix marks a spec as reconciliation's to own. */
export const FLOW_SCHEDULE_PREFIX = 'flow:';

export function flowScheduleSpecId(flowId: string, nodeId: string): string {
    return `${FLOW_SCHEDULE_PREFIX}${flowId}:${nodeId}`;
}

/** How a flow's schedule appears in the Processes list. */
function labelFor(flow: ScheduledFlow): string {
    return `${flow.name} (flow)`;
}

export function planFlowSchedules(
    desired: readonly ScheduledFlow[],
    existing: readonly ExistingFlowSchedule[],
): FlowSchedulePlan {
    const want = new Map<string, FlowScheduleSpec>(
        desired.map((flow) => {
            const specId = flowScheduleSpecId(flow.flowId, flow.nodeId);
            return [
                specId,
                { specId, flowId: flow.flowId, nodeId: flow.nodeId, cron: flow.cron, label: labelFor(flow) },
            ] as const;
        }),
    );
    const have = new Map(existing.map((e) => [e.specId, e] as const));

    const create: FlowScheduleSpec[] = [];
    const update: FlowScheduleSpec[] = [];

    for (const [specId, spec] of want) {
        const current = have.get(specId);
        if (!current) {
            create.push(spec);
            continue;
        }
        // Drift, not equality of the whole row: only the two fields the scheduler
        // and the user actually read can be wrong here.
        if (current.cron !== spec.cron || current.label !== spec.label) update.push(spec);
    }

    const remove = [...have.keys()].filter((specId) => !want.has(specId));

    return {
        create,
        update,
        delete: remove,
        changed: create.length > 0 || update.length > 0 || remove.length > 0,
    };
}
