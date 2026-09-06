/**
 * The flow system, wired.
 *
 * ONE system. A GApp's flow is a flow whose scope is `gapp`; it uses the same
 * table, the same runner, the same node palette and the same editor as every
 * other flow. There is no second path anywhere in this directory.
 *
 * What lives here is the part that cannot be pure: the event registry and its
 * producers, the bus that turns an event into runs, and the wiring that starts
 * and stops all of it. Everything it depends on — reading triggers off a graph,
 * choosing which flows an event reaches, deciding what a flow may do, running it
 * — is a pure function in its own module with its own tests.
 *
 * ## Triggers, and why cron is not here
 *
 * Four kinds. `manual` is a person or an agent pressing Run. `schedule` is armed
 * through `manageProcess`'s existing scheduler — Genie does not grow a second
 * cron, and `scheduler.ts` reconciles what should be armed against what is.
 * `event` is this file. `webhook` is honestly refused: there is nowhere for an
 * inbound request to land yet.
 *
 * The owner's constraint, which shapes the whole trigger design:
 *
 *   > Ops running should not be tied to an agent request unless it's a manual
 *   > trigger. We need to support several triggers, including time based
 *   > triggers. so if any time based triggers exist, a cron checker should auto
 *   > be started.
 *
 * ## Loops
 *
 * A flow that writes a file will hear its own write back from the watcher, with
 * nothing in the event to say who caused it. `FlowLoopGuard` carries the CHAIN —
 * which run, how deep — so a cycle is caught at admission rather than after it
 * has run twice.
 */

import fs from 'node:fs';
import { getAppGrant, listWorkspaces } from '../db';
import { dispatchAppCall } from '../apps/bridge';
import { onFileWatchEvent, unwatchWorkspace, watchWorkspace } from '../files/watch';
import { setFlowFireHandler } from '../terminal/process-scheduler';
import { broadcastLocal } from '../remote';
import type { ServerDeps } from '../mcp/server';
import type { AppGrant } from '../apps/bridge-decision';
import { FlowActivity, type FlowRunRecord } from './activity';
import { dispatchFlowCall } from './dispatch-call';
import { createFlowEventRegistry, type FlowEventRegistry } from './events';
import { registerEventTriggerKind } from './event-trigger';
import { FILE_ADDED_EVENT, startFlowFileSource } from './file-source';
import { registerGenieKinds } from './kinds';
import { FlowLoopGuard } from './loop';
import {
    recordFlowRun,
    recordFlowRunStart,
    reconcileInterruptedFlowRuns,
    pruneFlowRuns,
} from './run-store';
import { runStoredFlow, type FlowRunnerDeps, type FlowRunResult } from './runner';
import { reconcileFlowSchedules } from './scheduler';
import { selectFlowsForEvent } from './select';
import { getFlow, listFlows } from './store';
import { declaredTriggers } from './triggers';
import { planFlowFileWatches } from './watch-plan';
import type { FlowEvent, FlowRunOutcome } from './types';
import type { WatchableWorkspace } from './watch-plan';

/* ===== the registry =================================================== */

let registry: FlowEventRegistry | null = null;

/**
 * The workstation's event registry.
 *
 * Constructed rather than a module constant so a test gets its own — a shared
 * mutable list would leak an event registered by one test into whichever ran
 * next. Production makes exactly one.
 */
export function flowEventRegistry(): FlowEventRegistry {
    if (!registry) registry = createFlowEventRegistry();
    return registry;
}

/* ===== identity ======================================================= */

function grantFor(appId: string): AppGrant | null {
    const row = getAppGrant(appId);
    if (!row) return null;
    return {
        appId: row.appId,
        appName: row.name,
        workspaceId: row.workspaceId,
        scope: row.scope,
        capabilities: row.capabilities,
        revoked: row.revoked,
        ...(row.workspaces ? { workspaces: row.workspaces } : {}),
    };
}

/**
 * The runner's dependencies, bound to production.
 *
 * Two dispatchers, one destination. A `gapp` flow's steps go through
 * `dispatchAppCall` — the SAME function the GApp window's bridge calls, so a
 * flow is another caller of that gate rather than a second path to the tools
 * behind it. A user-scoped flow goes through `dispatchFlowCall`, which builds
 * the same `tools/call` message and hands it to the same `handleMcpMessage`.
 * There is no tool implemented twice anywhere in this.
 */
export function flowRunnerDeps(deps: ServerDeps): FlowRunnerDeps {
    return {
        loadFlow: getFlow,
        loadGrant: grantFor,
        dispatch: (caller, input) =>
            caller.kind === 'app'
                ? dispatchAppCall(caller.appId, input, deps)
                : dispatchFlowCall(caller.flowId, input, deps),
    };
}

/* ===== live state ===================================================== */

const activity = new FlowActivity();

/** Push the run feed to every local window. Host-bound windows are skipped. */
function pushActivity(finished?: FlowRunRecord): void {
    broadcastLocal('flows:activity', {
        running: activity.runningFlowIds(),
        ...(finished ? { finished } : {}),
    });
}

export function pushFlowsChanged(): void {
    broadcastLocal('flows:changed', {});
}

export function flowActivitySnapshot(): { running: string[]; busy: boolean } {
    const running = activity.runningFlowIds();
    return { running, busy: running.length > 0 };
}

/* ===== running ======================================================== */

const guard = new FlowLoopGuard();

/**
 * Run one flow, record it, and tell every window.
 *
 * The record is written at START as well as at finish, so a run cut short by a
 * crash leaves a trace instead of vanishing — `reconcileInterruptedFlowRuns`
 * turns those into `interrupted` at the next boot, because the runtime cannot
 * log "Genie died on top of me".
 */
async function runAndRecord(
    flowId: string,
    request: Parameters<typeof runStoredFlow>[1],
    deps: ServerDeps,
    event?: FlowEvent,
): Promise<FlowRunResult & { outcome: FlowRunOutcome; runId: string }> {
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const at = Date.now();

    activity.started({ flowId, runId, at, ...(event ? { event: event.event } : {}) });
    recordFlowRunStart({ flowId, runId, at, ...(event ? { event: event.event } : {}) });
    pushActivity();

    const result = await runStoredFlow(flowId, request, flowRunnerDeps(deps));

    const outcome: FlowRunOutcome = result.ok
        ? 'ran'
        : result.refusals && result.refusals.length > 0
          ? 'refused'
          : 'failed';

    const record = activity.finished({
        flowId,
        runId,
        outcome,
        at: Date.now(),
        ...(event ? { event: event.event } : {}),
        ...(result.error ? { reason: result.error } : {}),
    });
    if (record) recordFlowRun(record);
    pushActivity(record ?? undefined);

    return { ...result, outcome, runId };
}

/** A person or an agent pressed Run. The only trigger tied to a request. */
export async function runFlowManually(flowId: string, deps: ServerDeps) {
    return runAndRecord(flowId, { trigger: 'manual' }, deps);
}

/* ===== the bus ======================================================== */

let serverDeps: ServerDeps | null = null;

/**
 * Something happened. Run every flow that was listening.
 *
 * Runs are started in parallel and NOT awaited together as one unit: a flow that
 * takes an hour must not delay a flow that takes a second, and one that throws
 * must not stop the others from hearing the event.
 */
export async function emitFlowEvent(event: FlowEvent): Promise<void> {
    if (!serverDeps) return;

    const chosen = selectFlowsForEvent(
        listFlows(),
        event,
        (appId) => grantFor(appId)?.workspaceId ?? null,
    );

    await Promise.all(
        chosen.map(async (selected) => {
            // The loop guard is asked PER FLOW, because a loop is a property of
            // the chain an event belongs to — a flow reacting to its own write
            // is a cycle, while a different flow reacting to it is ordinary.
            const decision = guard.admit(selected.flowId, event);
            if (!decision.ok) return;
            guard.noteRun(selected.flowId);

            for (const nodeId of selected.nodeIds) {
                await runAndRecord(
                    selected.flowId,
                    { trigger: 'event', nodeId, props: { ...event.props } },
                    serverDeps!,
                    event,
                );
            }
        }),
    );
}

/* ===== watching ======================================================= */

let stopFileSource: (() => void) | null = null;

/** Watched root → the workspace it belongs to. Also this module's reference set. */
let watched = new Map<string, string>();

function watchableWorkspaces(): WatchableWorkspace[] {
    return listWorkspaces()
        .filter((w) => typeof w.path === 'string' && w.path !== '')
        .map((w) => ({ id: w.id, path: w.path as string }));
}

/** `null` when the path is gone or unreadable — never throws. */
function statFile(absPath: string): { isFile: boolean; size: number } | null {
    try {
        const s = fs.statSync(absPath);
        return { isFile: s.isFile(), size: s.size };
    } catch {
        return null;
    }
}

/**
 * Start watching exactly the workspaces some flow could react to.
 *
 * Derived from what the flows SAY rather than watching everything on the chance
 * somebody writes a file flow later: a recursive watcher on every workspace is
 * real cost for a machine with none.
 */
export function reconcileFlowWatches(): void {
    const plan = planFlowFileWatches(listFlows(), watchableWorkspaces(), flowEventRegistry());
    const next = new Map(plan.map((w) => [w.path, w.id]));

    // References this module holds are released before the new plan is taken, so
    // disabling a flow actually stops the watcher rather than leaving it running
    // until the next restart. Panels hold their OWN references, so a workspace
    // open in the Code view keeps its watcher either way.
    for (const root of watched.keys()) {
        if (!next.has(root)) unwatchWorkspace(root);
    }
    for (const root of next.keys()) {
        if (!watched.has(root)) watchWorkspace(root);
    }
    watched = next;
}

/* ===== lifecycle ====================================================== */

/**
 * Bring the flow system up. Called once at boot.
 *
 * Order matters twice over:
 *
 *  1. Node kinds are registered FIRST, because everything downstream reads the
 *     registry — `declaredTriggers` resolves kinds, and a graph whose trigger
 *     kind is unknown declares no trigger, which for a schedule is the worst
 *     failure available: the flow looks armed and never fires.
 *  2. The scheduler's fire handler is wired BEFORE reconciliation, so no timer
 *     can come due with nowhere to fire.
 */
export function startFlows(deps: ServerDeps): () => void {
    serverDeps = deps;

    registerGenieKinds();
    registerEventTriggerKind(flowEventRegistry());

    setFlowFireHandler(async (flowId) => {
        // A schedule fires the node it was armed for; every other trigger's
        // branch stays inactive.
        const flow = getFlow(flowId);
        const node = flow?.graph
            ? declaredTriggers(flow.graph).find((t) => t.kind === 'schedule')?.nodeId
            : undefined;
        const result = await runAndRecord(
            flowId,
            { trigger: 'schedule', ...(node ? { nodeId: node } : {}) },
            deps,
        );
        return result.ok;
    });

    // BEFORE anything can run, so a `running` row is orphaned by definition
    // rather than by a guess about its age. A run that was going when Genie
    // stopped cannot report its own death.
    try {
        const orphaned = reconcileInterruptedFlowRuns();
        if (orphaned > 0) {
            console.log(
                `[flows] ${orphaned} run${orphaned === 1 ? '' : 's'} were in progress when ` +
                    `Genie last stopped; marked interrupted.`,
            );
        }
        pruneFlowRuns();
    } catch (e) {
        console.log(`[flows] could not reconcile interrupted runs: ${String(e)}`);
    }

    // Subscribed BEFORE anything is watched, so no event can arrive with nowhere
    // to go.
    stopFileSource = startFlowFileSource({
        subscribe: onFileWatchEvent,
        statFile,
        workspaceIdFor: (workspacePath) => watched.get(workspacePath),
        emit: (event) => void emitFlowEvent(event),
    });

    reconcileFlowSchedules();
    reconcileFlowWatches();

    return stopFlows;
}

/** Release every watcher this module took, and stop the source. */
export function stopFlows(): void {
    stopFileSource?.();
    stopFileSource = null;
    serverDeps = null;
    for (const root of watched.keys()) unwatchWorkspace(root);
    watched = new Map();
}

/* ===== re-exports ===================================================== */

export * from './types';
export { FILE_ADDED_EVENT } from './file-source';
export { createFlowEventRegistry, BUILT_IN_FLOW_EVENTS } from './events';
export { FlowLoopGuard } from './loop';
export { FlowActivity, type FlowRunRecord } from './activity';
export { selectFlowsForEvent } from './select';
export { decideFlowAdmission } from './admission';
export { authorityForScope } from './authority';
export { declaredTriggers, armableSchedules, eventTriggersFor } from './triggers';
export { runStoredFlow } from './runner';
export {
    getFlow,
    listFlows,
    listFlowsVisibleTo,
    upsertFlow,
    setFlowEnabled,
    deleteFlow,
    listScheduledFlows,
    type FlowRow,
    type FlowInput,
} from './store';
export { listFlowRuns, lastFlowRuns } from './run-store';
export { starterFlowGraph, newFlowNode, newFlowEdge } from './graph';
export { genieNodeDefinitions, registerGenieKinds } from './kinds';
export { GENIE_EVENT_TRIGGER_KIND } from './event-trigger';
