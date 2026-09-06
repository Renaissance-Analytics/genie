/**
 * PURE. Which flows an event reaches, and which of their trigger nodes fired.
 *
 * ## It returns NODES, not just flows
 *
 * A graph may hold a manual trigger for hand-testing beside the event trigger
 * that runs it for real. A trigger has no inbound edges, which IS the engine's
 * readiness rule — so unless the run names which entry points are live, EVERY
 * trigger's branch runs on every fire. The engine's own note gives the sharpest
 * case: a `user_input` stranded on the manual branch parks an event-driven run
 * to ask a person for data the event already supplied, which from outside looks
 * like the event trigger being ignored.
 *
 * So selection answers both halves of the question at once, and `runStoredFlow`
 * passes the node ids straight through as `entryNodes`.
 *
 * ## Scope decides WHO HEARS an event
 *
 * This is the second thing scope does, and it is the promise of the middle rung:
 *
 *  - a `system` flow hears everything;
 *  - a `workspace` flow hears only events carrying ITS workspace id — and
 *    notably NOT an event that names no workspace, because an event that could
 *    be about anything is not that flow's business;
 *  - a `gapp` flow hears only events carrying its app's workspace, through the
 *    same rule as a workspace flow.
 *
 * It is still not a security boundary. A flow that hears an event is then judged
 * by `decideFlowAdmission` and gated per call, and a workspace flow that somehow
 * ran on a foreign event still could not ACT outside its workspace.
 *
 * ## Nothing here names an event id
 *
 * The owner's #270 constraint. Adding an event kind is adding a registry entry;
 * no module that matches, selects or dispatches learns about it. Asserted from
 * both ends in `__tests__/event-triggers.test.ts`.
 */

import { eventTriggersFor } from './triggers';
import type { FlowRow } from './store';
import type { FlowEvent } from './types';

export interface SelectedFlow {
    flowId: string;
    /** The trigger nodes that matched — this run's live entry points. */
    nodeIds: string[];
}

/** The workspace an event is about, or null when it says nothing. */
function workspaceOf(event: FlowEvent): string | null {
    const raw = event.props.workspaceId;
    return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * Where a flow is confined to, or null when it is not confined.
 *
 * A `gapp` flow's workspace is its APP's, which lives in the grant — so it is
 * looked up rather than read off the row. Injected so this module stays pure:
 * the alternative is importing the grant store here, which would put the
 * database behind a function whose whole value is being testable without one.
 */
function confinedTo(
    flow: FlowRow,
    appWorkspaceId: (appId: string) => string | null,
): string | null | undefined {
    const scope = flow.scope!;
    if (scope.kind === 'system') return null;
    if (scope.kind === 'workspace') return scope.workspaceId;
    // `undefined` for an app whose grant is gone: not confined to nothing, but
    // unknowable — and an unknowable confinement hears nothing.
    return appWorkspaceId(scope.appId) ?? undefined;
}

export function selectFlowsForEvent(
    flows: readonly FlowRow[],
    event: FlowEvent,
    appWorkspaceId: (appId: string) => string | null = () => null,
): SelectedFlow[] {
    const eventWorkspace = workspaceOf(event);

    return flows.flatMap((flow) => {
        // Disarmed, unreadable scope, unreadable graph. Each of these is a flow
        // Genie declines to run rather than one it guesses about — a corrupt row
        // must not become the widest behaviour.
        if (!flow.enabled || !flow.scope || !flow.graph) return [];

        const confinement = confinedTo(flow, appWorkspaceId);
        if (confinement !== null) {
            // Confined. It hears an event only when the event says which
            // workspace it is about AND that is this one. An event naming no
            // workspace could be about anything, so it is not this flow's.
            if (confinement === undefined) return [];
            if (eventWorkspace !== confinement) return [];
        }

        const nodeIds = eventTriggersFor(flow.graph, event.event).map((t) => t.nodeId);
        return nodeIds.length > 0 ? [{ flowId: flow.id, nodeIds }] : [];
    });
}
