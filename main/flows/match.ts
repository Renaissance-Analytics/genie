/**
 * PURE. Which Flows an event selects, and who may see a Flow at all.
 *
 * Two questions that look unrelated and are the same question: both are
 * answered from the Flow's `scope`, and both are answered HERE rather than in
 * whichever surface is asking. A menu that decided visibility for itself would
 * be a second implementation of an authorisation rule, and the second
 * implementation is the one that gets it wrong.
 *
 * Nothing in this file knows an event kind. It is handed a registry and asks it
 * questions; an event it has never heard of is refused with a reason, not
 * guessed at. That is the property `__tests__/extensible-events.test.ts` pins
 * down structurally.
 */

import { matchesFlowFilter, FlowFilterError } from './filter';
import type { FlowEventRegistry } from './events';
import type { Flow, FlowEvent, FlowEventTrigger } from './types';

export interface FlowTriggerMatch {
    flow: Flow;
    trigger: FlowEventTrigger;
}

/** A Flow that WANTED this event but could not be judged. Never silent. */
export interface FlowMatchProblem {
    flowId: string;
    event: string;
    reason: string;
}

export interface FlowSelection {
    matches: FlowTriggerMatch[];
    problems: FlowMatchProblem[];
}

/**
 * The workspace an event happened in, when it names one.
 *
 * Read by convention from a `workspaceId` prop rather than a field on the event,
 * because plenty of event kinds have no workspace at all (a machine woke up, an
 * upgrade landed) and a required field would force every producer to invent one.
 */
export const WORKSPACE_PROP = 'workspaceId';

function eventWorkspaceId(event: FlowEvent): string | undefined {
    const v = event.props[WORKSPACE_PROP];
    return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Whether this Flow is allowed to react to this event AT ALL, before any filter.
 *
 * A workspace-scoped Flow only ever sees its own workspace's events. That is the
 * difference between "runs when a file lands in this project" and "runs when a
 * file lands in any project on the machine", and getting it wrong means a Flow
 * quietly acting on somebody else's repository. An event that names NO workspace
 * cannot be shown to be in scope, so it is not — fail closed.
 */
export function eventInScope(flow: Flow, event: FlowEvent): boolean {
    if (flow.scope.kind !== 'workspace') return true;
    return eventWorkspaceId(event) === flow.scope.workspaceId;
}

/**
 * Every (flow, trigger) pair this event fires, plus every Flow that wanted it
 * and could not be judged.
 *
 * Disabled Flows are skipped silently — that is what disabled means. A Flow
 * whose trigger names an unregistered event is skipped silently too: it is
 * ARMED for something this build does not emit (a GApp uninstalled, a producer
 * not yet shipped), which is a fact about the machine rather than a fault. A
 * filter that cannot be EVALUATED is a fault, and is reported.
 */
export function selectFlowsForEvent(
    flows: readonly Flow[],
    event: FlowEvent,
    registry: FlowEventRegistry,
): FlowSelection {
    const matches: FlowTriggerMatch[] = [];
    const problems: FlowMatchProblem[] = [];

    if (!registry.get(event.event)) return { matches, problems };

    for (const flow of flows) {
        if (!flow.enabled) continue;
        if (!eventInScope(flow, event)) continue;

        for (const trigger of flow.triggers) {
            if (trigger.kind !== 'event' || trigger.event !== event.event) continue;
            try {
                if (matchesFlowFilter(trigger.filter, event.props)) {
                    matches.push({ flow, trigger });
                }
            } catch (e) {
                problems.push({
                    flowId: flow.id,
                    event: event.event,
                    reason:
                        e instanceof FlowFilterError
                            ? e.message
                            : `filter could not be evaluated: ${e instanceof Error ? e.message : String(e)}`,
                });
            }
            // One match per Flow per event: two triggers on the same event kind
            // are alternatives ("either of these"), not two runs.
            if (matches[matches.length - 1]?.flow === flow) break;
        }
    }

    return { matches, problems };
}

/** Who is asking to see a Flow. A GApp asks as itself; everything else does not. */
export type FlowViewer = { kind: 'system' } | { kind: 'gapp'; appId: string };

/**
 * Whether `viewer` may see `flow` in a menu.
 *
 * The one rule with teeth: a `gapp`-scoped Flow appears in NO menu outside its
 * own GApp. Enforced here so the (deferred) grouped menu, an agent's tool list
 * and anything else added later all read the same answer.
 *
 * There is no second field to consult (genie#394): the scope IS the visibility.
 * A GApp Flow meant to be seen machine-wide is scoped `system`, and falls
 * through the first line like any other non-`gapp` Flow.
 */
export function isFlowVisibleTo(flow: Flow, viewer: FlowViewer): boolean {
    if (flow.scope.kind !== 'gapp') return true;
    return viewer.kind === 'gapp' && viewer.appId === flow.scope.appId;
}

/** True when a human can start this Flow by hand. */
export function isManuallyRunnable(flow: Flow): boolean {
    return flow.enabled && flow.triggers.some((t) => t.kind === 'manual');
}
