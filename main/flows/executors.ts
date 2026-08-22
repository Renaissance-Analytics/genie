/**
 * The ONE door. Every way a flow reaches Genie goes through this file.
 *
 * fancy-flow looks executors up by the node's coarse TYPE — one of six — and
 * never by `data.kind`. Registering a precise per-kind executor does nothing;
 * a coarse one shadows it. Usually that is described as a footgun, and it is,
 * but taken deliberately it is the better security shape: Genie registers a
 * SINGLE `action` executor, and that function is the only place a node's kind
 * becomes a Genie call. No per-kind executor exists to be added later with its
 * own path to the bridge, because per-kind executors do not work at all.
 *
 * ## The rule that lives here
 *
 * Identity comes from the RUN, never from the graph — the same rule `bridge.ts`
 * states for windows, for the same reason. A graph is data the app itself wrote,
 * so an `appId` in a node's config is a suggestion from an untrusted source. The
 * app id is closed over when the registry is built and there is no field for a
 * node to override it.
 *
 * ## Why a kind that is not ours ABORTS
 *
 * fancy-flow's builtin kit includes `api_request` (arbitrary outbound HTTP) and
 * `webhook_out`. It ships no executor for either, so they are inert unless a host
 * implements them — and Genie does not. But "inert because nobody implemented it"
 * degrades the moment someone adds a general fallback, so the fallback here is an
 * abort with a reason rather than a shrug. A step Genie cannot account for stops
 * the run.
 *
 * That also means a refusal from the bridge stops the flow. A denied step that
 * returned undefined and let the graph carry on would turn "permission denied"
 * into "silently did half the automation" — the worst of the available outcomes,
 * because it reports success.
 */

import { toolForNodeKind } from './nodes';

/** What the bridge gives back. Structurally `AppCallResult` from `apps/bridge`. */
export interface FlowDispatchResult {
    ok: boolean;
    result?: unknown;
    error?: string;
}

/**
 * The bridge, as this module needs it.
 *
 * Injected rather than imported so the security decisions here are testable
 * without an Electron main process, and so there is exactly one implementation
 * in production: `dispatchAppCall`.
 */
export type FlowDispatch = (
    appId: string,
    input: { tool: string; args: unknown; workspaceId: string | undefined },
) => Promise<FlowDispatchResult>;

/** The ctx `runFlow` hands an executor, narrowed to what Genie reads. */
interface ExecutorCtx {
    node: {
        id?: unknown;
        type?: unknown;
        data?: { kind?: unknown; label?: unknown; config?: unknown } | null;
    };
    inputs: Record<string, unknown>;
    abort: (reason?: string) => never;
    emit: (event: unknown) => void;
}

type Executor = (ctx: ExecutorCtx) => Promise<unknown> | unknown;

function readString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * The single input a node with one meaningful input carries.
 *
 * fancy-flow keys inputs by port id, and the convention across the builtin kit is
 * a `value` port. Falling back to the sole input keeps a hand-wired graph working
 * without guessing among several.
 */
function soleInput(inputs: Record<string, unknown>): unknown {
    if (inputs && typeof inputs === 'object' && 'value' in inputs) return inputs.value;
    const values = Object.values(inputs ?? {});
    return values.length === 1 ? values[0] : inputs;
}

/**
 * Build the executor registry for one app's flow run.
 *
 * `appId` is closed over — that is the whole identity story. Everything else is
 * decided per node, by kind, at the one door below.
 */
export function buildFlowExecutors(
    appId: string,
    dispatch: FlowDispatch,
): Record<string, Executor> {
    /** THE DOOR. */
    const action: Executor = async (ctx) => {
        const kind = readString(ctx.node.data?.kind);
        if (!kind) {
            return ctx.abort('This step has no kind, so Genie cannot tell what it would do.');
        }

        const tool = toolForNodeKind(kind);
        if (!tool) {
            // Either somebody else's node (a Fancy builtin, a marketplace node) or
            // a `genie.` kind that resolves to nothing. Genie implements neither,
            // and a step it cannot account for must stop the run rather than be
            // quietly skipped.
            return ctx.abort(
                `Genie does not run “${kind}”. Only Genie steps can act from a flow.`,
            );
        }

        const config = ctx.node.data?.config;
        const workspaceId =
            config && typeof config === 'object'
                ? (readString((config as { workspaceId?: unknown }).workspaceId) ?? undefined)
                : undefined;

        const outcome = await dispatch(appId, { tool, args: config, workspaceId });
        if (!outcome.ok) {
            return ctx.abort(outcome.error ?? `“${tool}” was refused.`);
        }
        return outcome.result;
    };

    return {
        /**
         * A trigger's job is to exist and hand the run its starting payload; the
         * decision to run at all was made before `runFlow` was called.
         */
        trigger: (ctx) => (ctx.node.data?.config ?? {}) as unknown,

        action,

        /**
         * Truthiness, and nothing cleverer. A richer condition language would be
         * a host-supplied expression evaluator, and the engine deliberately ships
         * no `eval` (verified); Genie is not going to be the one to introduce it.
         */
        decision: (ctx) => ({ branch: soleInput(ctx.inputs) ? 'true' : 'false' }),

        /** The value the flow arrived at. */
        output: (ctx) => soleInput(ctx.inputs),

        /** Annotation. Carries no behaviour, and must not acquire any. */
        note: () => null,

        // `subgraph` is DELIBERATELY absent. Flow-to-flow references need a
        // resolver and, more importantly, an answer about whose grant the child
        // runs under. Until that is decided, an unregistered type makes `runFlow`
        // abort — which is the correct half-answer.
    };
}
