/**
 * Load, judge, then run — and never in a different order.
 *
 * The ordering is the feature. A flow graph is inert data, so the whole thing can
 * be judged before any of it happens; a runner that started the graph and let the
 * bridge refuse step by step would leave every step BEFORE the refused one
 * already done. For an automation that means a half-finished job reported as a
 * permission error, which is worse than either a clean refusal or a clean run.
 *
 * The bridge is still the lock. `buildFlowExecutors` calls `decideAppCall`
 * (through `dispatchAppCall`) for every step of an admitted graph, because a
 * graph can be edited between admission and run, and because a check that only
 * happens once is a check that eventually gets skipped.
 *
 * Dependencies are injected so this ordering is testable without an Electron main
 * process or a database. Production binds them in `ipc.ts`; there is no
 * test-only path that could pass while production differs.
 */

import { runFlow } from '@particle-academy/fancy-flow/engine';
import { decideFlowAdmission, type FlowNodeRefusal } from './admission';
import { buildFlowExecutors, type FlowDispatch } from './executors';
import type { AppGrant } from '../apps/bridge-decision';
import type { FlowRow } from './store';

export interface FlowRunnerDeps {
    loadFlow: (flowId: string) => FlowRow | null;
    loadGrant: (appId: string) => AppGrant | null;
    dispatch: FlowDispatch;
}

export interface FlowRunOutcome {
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
    deps: FlowRunnerDeps,
    onEvent?: (event: unknown) => void,
): Promise<FlowRunOutcome> {
    const flow = deps.loadFlow(flowId);
    if (!flow) {
        return { ok: false, error: 'That flow no longer exists.' };
    }
    if (!flow.enabled) {
        // Honoured here rather than only in the scheduler, so a flow the user
        // turned off is off however the run was asked for — by timer or by hand.
        return { ok: false, error: `“${flow.name}” is turned off.` };
    }
    if (!flow.graph) {
        return {
            ok: false,
            error: `“${flow.name}” could not be read as a graph, so it was not run.`,
        };
    }

    const grant = deps.loadGrant(flow.appId);
    const admission = decideFlowAdmission(flow.graph, grant);
    if (!admission.allowed) {
        return {
            ok: false,
            ...(admission.reason ? { error: admission.reason } : {}),
            refusals: admission.refusals,
        };
    }

    const executors = buildFlowExecutors(flow.appId, deps.dispatch);
    const result = await runFlow(
        flow.graph as never,
        executors as never,
        onEvent as never,
        { timeoutMs: RUN_TIMEOUT_MS },
    );

    return {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        capabilities: admission.capabilities,
        outputs: result.outputs,
    };
}
