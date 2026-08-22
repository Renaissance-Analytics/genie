/**
 * PURE. What starts a flow, read off the graph rather than configured beside it.
 *
 * The owner's constraint (2026-08-22), verbatim:
 *
 *   > Ops running should not be tied to an agent request unless it's a manual
 *   > trigger. We need to support several triggers, including time based
 *   > triggers. so if any time based triggers exist, a cron checker should auto
 *   > be started.
 *
 * So a schedule is a property OF a flow, declared on the canvas, and Genie's job
 * is to notice one and arm it — not to wait for somebody to wire it up
 * afterwards. `manual` is the only trigger tied to a request.
 *
 * ## There is no cron in here
 *
 * Genie already has a host scheduler: `manageProcess` scheduled tasks, armed by
 * `main/terminal/process-scheduler.ts`, which fire whether or not anyone has
 * Genie open and are re-armed at launch. This module decides WHAT should be
 * armed; that one decides WHEN and does the arming. A second cron implementation
 * would be duplicate machinery that could disagree with the first about what
 * "every morning" means — so cron validity is `isValidCron`'s answer, not ours.
 *
 * ## Aliases are not optional
 *
 * fancy-flow publishes each builtin under its namespaced id AND legacy aliases
 * (`schedule_trigger`, `@fancy/schedule_trigger`). A graph written by hand or
 * saved by an older editor uses them. Missing an alias would mean silently
 * declaring NO trigger — for a schedule, the worst failure available: the flow
 * looks armed and never fires.
 */

import { isValidCron } from '../terminal/cron';
import type { FlowGraphLike, FlowNodeLike } from './admission';

export type FlowTriggerKind = 'manual' | 'schedule' | 'webhook';

export interface FlowTrigger {
    nodeId: string;
    kind: FlowTriggerKind;
    /** `schedule` only: a 5-field cron expression, in the host's local time. */
    cron?: string;
    /** Set when Genie recognises the trigger but cannot arm it yet, and why. */
    unsupported?: string;
}

/** A schedule Genie will actually arm. */
export interface ArmableSchedule {
    nodeId: string;
    cron: string;
}

/**
 * Trigger kinds, including every alias fancy-flow publishes for them.
 *
 * Listed rather than derived because the aliases are a compatibility promise
 * about strings already written into saved graphs; deriving them from the live
 * registry would make an old graph's meaning depend on the installed version.
 */
const TRIGGER_KINDS: ReadonlyMap<string, FlowTriggerKind> = new Map([
    ['@particle-academy/manual_trigger', 'manual'],
    ['manual_trigger', 'manual'],
    ['@fancy/manual_trigger', 'manual'],
    ['@particle-academy/schedule_trigger', 'schedule'],
    ['schedule_trigger', 'schedule'],
    ['@fancy/schedule_trigger', 'schedule'],
    ['@particle-academy/webhook_trigger', 'webhook'],
    ['webhook_trigger', 'webhook'],
    ['@fancy/webhook_trigger', 'webhook'],
]);

const WEBHOOK_UNSUPPORTED =
    'Genie cannot arm a webhook trigger yet — there is nowhere for an inbound request to land. This flow will only run when started by hand.';

function nodesOf(graph: FlowGraphLike | null | undefined): readonly FlowNodeLike[] {
    return graph && Array.isArray(graph.nodes) ? graph.nodes : [];
}

function readString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

export function declaredTriggers(graph: FlowGraphLike | null | undefined): FlowTrigger[] {
    const found: FlowTrigger[] = [];

    for (const raw of nodesOf(graph)) {
        if (!raw || typeof raw !== 'object') continue;
        const kindId = readString(raw.data?.kind);
        if (!kindId) continue;
        const kind = TRIGGER_KINDS.get(kindId);
        if (!kind) continue;

        const nodeId = readString(raw.id) ?? '';
        const config = raw.data?.config;
        const cron =
            kind === 'schedule' && config && typeof config === 'object'
                ? readString((config as { cron?: unknown }).cron)
                : null;

        found.push({
            nodeId,
            kind,
            ...(cron !== null ? { cron } : {}),
            ...(kind === 'webhook' ? { unsupported: WEBHOOK_UNSUPPORTED } : {}),
        });
    }

    return found;
}

/**
 * The schedules Genie will arm for this graph.
 *
 * A schedule trigger with a missing or unparseable cron is dropped rather than
 * armed on a guess. An author gets a flow that plainly does not run on a
 * schedule, which is recoverable; a flow armed on a misread expression fires at
 * a time nobody chose, which is not.
 */
export function armableSchedules(graph: FlowGraphLike | null | undefined): ArmableSchedule[] {
    return declaredTriggers(graph)
        .filter((t): t is FlowTrigger & { cron: string } => t.kind === 'schedule' && !!t.cron)
        .filter((t) => isValidCron(t.cron))
        .map((t) => ({ nodeId: t.nodeId, cron: t.cron }));
}

/** Whether this graph gives Genie any scheduling to do at all. */
export function hasTimeTrigger(graph: FlowGraphLike | null | undefined): boolean {
    return armableSchedules(graph).length > 0;
}
