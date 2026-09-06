/**
 * Load, judge, then run — and never in a different order.
 *
 * The ordering is the feature. A flow graph is inert data, so the whole thing
 * can be judged before any of it happens; a runner that started the graph and
 * let the gate refuse step by step would leave every step BEFORE the refused one
 * already done. For an automation that means a half-finished job reported as a
 * permission error, which is worse than either a clean refusal or a clean run.
 *
 * The gate is still live per call. `buildFlowExecutors` dispatches every step
 * through `dispatchAppCall` or `dispatchFlowCall`, because a check that only
 * happens once is a check that eventually gets skipped.
 *
 * ## Which trigger fired decides which branch runs
 *
 * A graph may hold several triggers — a manual one for hand-testing beside the
 * schedule that runs it for real. A trigger has no inbound edges, which IS the
 * engine's readiness rule, so without naming the live entry points EVERY
 * trigger's branch runs on every fire. The engine's own note gives the sharpest
 * example: a `user_input` stranded on the manual branch parks an event-driven
 * run to ask a person for data the event already supplied, which from outside
 * looks like the event trigger being ignored.
 *
 * So `entryNodes` is always passed, and `runStoredFlow` requires the caller to
 * say what started the run.
 *
 * Dependencies are injected so this ordering is testable without an Electron
 * main process or a database. Production binds them in `ipc.ts`; there is no
 * test-only path that could pass while production differs.
 */

import { runFlow } from '@particle-academy/fancy-flow/engine';
import { decideFlowAdmission, type FlowNodeRefusal } from './admission';
import { authorityForScope } from './authority';
import { buildFlowExecutors, type FlowCaller, type FlowDispatch } from './executors';
import { declaredTriggers, type FlowTriggerKind } from './triggers';
import type { AppGrant } from '../apps/bridge-decision';
import type { FlowRow } from './store';

export interface FlowRunnerDeps {
    loadFlow: (flowId: string) => FlowRow | null;
    loadGrant: (appId: string) => AppGrant | null;
    dispatch: FlowDispatch;
}

export interface FlowRunResult {
    ok: boolean;
    /** Why the run did not happen, or how it failed. */
    error?: string;
    /** Node-level refusals from admission. Empty when the refusal was graph-wide. */
    refusals?: FlowNodeRefusal[];
    /** Capabilities the graph used — only meaningful once admitted. */
    capabilities?: string[];
    /** Per-node outputs, when the run completed. */
    outputs?: Record<string, unknown>;
}

/** What started this run. */
export interface FlowRunRequest {
    /**
     * The kind of trigger that fired. Everything downstream of the OTHER
     * triggers stays inactive.
     */
    trigger: FlowTriggerKind;
    /** The trigger node, when one specific node fired (a schedule has several). */
    nodeId?: string;
    /** Values the event carried, checked against what the graph declares. */
    props?: Record<string, unknown>;
}

/**
 * How long a run may take before the engine stops it.
 *
 * A flow that hangs holds nothing but itself, but an unbounded one would sit
 * there forever after a step wedged — and a scheduled flow would then skip every
 * subsequent fire as "still going". An hour is far longer than any step Genie
 * exposes should need and short enough that a wedged run clears before the next
 * nightly fire.
 */
const RUN_TIMEOUT_MS = 60 * 60 * 1000;

export async function runStoredFlow(
    flowId: string,
    request: FlowRunRequest,
    deps: FlowRunnerDeps,
    onEvent?: (event: unknown) => void,
): Promise<FlowRunResult> {
    const flow = deps.loadFlow(flowId);
    if (!flow) {
        return { ok: false, error: 'That flow no longer exists.' };
    }
    if (!flow.enabled && request.trigger !== 'manual') {
        // A flow the user turned off does not fire on a timer or an event. It
        // can still be run BY HAND — that is what a disarmed flow is for, and
        // refusing it would leave no way to test one before arming it.
        return { ok: false, error: `“${flow.title}” is turned off.` };
    }
    if (!flow.graph) {
        return {
            ok: false,
            error: `“${flow.title}” could not be read as a graph, so it was not run.`,
        };
    }

    const authority = authorityForScope(flow.scope, deps.loadGrant);
    const admission = decideFlowAdmission(flow.graph, authority);
    if (!admission.allowed || !authority) {
        return {
            ok: false,
            ...(admission.reason ? { error: admission.reason } : {}),
            refusals: admission.refusals,
        };
    }

    const entryNodes = liveEntryNodes(flow, request);
    if (entryNodes.length === 0) {
        // Naming no live entry point would run NOTHING while reporting success —
        // an automation that silently does nothing is the failure hardest to
        // notice, so it is an error instead.
        return {
            ok: false,
            error: `“${flow.title}” has no ${request.trigger} trigger, so there was nothing to start.`,
        };
    }

    const caller: FlowCaller =
        authority.kind === 'app'
            ? { kind: 'app', appId: authority.grant!.appId }
            : { kind: 'flow', flowId: flow.id };

    const result = await runFlow(
        flow.graph as never,
        buildFlowExecutors(caller, deps.dispatch) as never,
        onEvent as never,
        {
            timeoutMs: RUN_TIMEOUT_MS,
            entryNodes,
            ...(request.props ? { props: request.props } : {}),
        } as never,
    );

    return {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        capabilities: admission.capabilities,
        outputs: result.outputs,
    };
}

/**
 * The trigger nodes this run actually started from.
 *
 * A named `nodeId` wins — a schedule graph may hold two, firing at different
 * times, and only one of them went off. Otherwise every trigger of the right
 * KIND is live, which is what a manual Run means on a graph with two manual
 * triggers.
 */
function liveEntryNodes(flow: FlowRow, request: FlowRunRequest): string[] {
    const triggers = declaredTriggers(flow.graph).filter((t) => t.kind === request.trigger);
    if (request.nodeId) {
        return triggers.some((t) => t.nodeId === request.nodeId) ? [request.nodeId] : [];
    }
    return triggers.map((t) => t.nodeId);
}
