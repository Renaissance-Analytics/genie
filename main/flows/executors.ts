/**
 * The ONE door. Every way a flow reaches Genie goes through this file.
 *
 * ## Why one door — the current reason, not the expired one
 *
 * This file used to justify itself with a limitation: *"fancy-flow looks
 * executors up by the node's coarse TYPE, and never by `data.kind`, so a precise
 * per-kind executor does nothing."* **That was true at v0.48 and is false now.**
 * `runFlow` walks `[node.id, node.type, ...kindIds(kind), "*"]` and takes the
 * first registry hit, so a per-kind executor resolves perfectly well.
 *
 * The door stays, on merits that are still true:
 *
 *  - **One place a node becomes an effect.** With a single entry, a kind
 *    structurally cannot acquire its own path to the bridge. With a registry of
 *    per-kind entries, the next kind added is one `dispatch` call away from
 *    being a second authority path, and nothing would fail if it were.
 *  - **`node.id` is tried FIRST.** A per-kind registry means a graph whose node
 *    is *named* after a registry key shadows that key — an author (or an app)
 *    could name a node `branch` and take over what `branch` means for that run.
 *    A wildcard-only registry has no key a node id can collide with.
 *  - **The refusal is central.** "Genie does not run this" is decided once, so a
 *    kind nobody has considered is refused by construction rather than by
 *    whoever adds it remembering to.
 *
 * ## Registering a kind cannot widen the door — but the reason CHANGED at 0.66.0
 *
 * This used to read: *"`NodeKindDefinition` also carries an optional `executor`,
 * and `runFlow` never consults it (verified)."* **That was true through 0.65.2
 * and is false now.** fancy-flow 0.66.0 gave `branch`, `transform`, `merge` and
 * `for_each` default executors on the kind, and taught `pickExecutor` to fall
 * back to one:
 *
 *     for (const id of executorLookupIds(node)) if (executors[id]) return executors[id];
 *     return getNodeKind(node.type ?? '')?.executor;      // ← new in 0.66.0
 *
 * The conclusion survives, on a different footing. `executorLookupIds` ends in
 * `"*"`, and the registry below is wildcard-only, so the door is hit for EVERY
 * node and the fallback is unreachable. That is now the whole of what keeps a
 * registered kind from running its own code — which makes the wildcard
 * load-bearing rather than merely tidy, and is why removing it would not fail
 * loudly. Genie's executors are stricter than the new defaults, not equivalent
 * to them: `for_each` is refused outright where the default succeeds, and an
 * unresolved path throws where the default yields nothing. So a silent handover
 * would keep the flows running and change what they mean.
 *
 * `executors.test.ts` pins it by behaviour rather than by this paragraph.
 *
 * ## The rule that lives here
 *
 * Identity comes from the RUN, never from the graph — the same rule `bridge.ts`
 * states for windows, for the same reason. A graph is data the app itself wrote,
 * so an `appId` in a node's config is a suggestion from an untrusted source. The
 * app id is closed over when the registry is built and there is no field for a
 * node to override it.
 *
 * ## A refusal STOPS the flow
 *
 * A denied step that returned undefined and let the graph carry on would turn
 * "permission denied" into "silently did half the automation" — the worst of the
 * available outcomes, because it reports success and nobody looks at a green run.
 */

import { getNodeKind } from '@particle-academy/fancy-flow/engine';
import { builtinExecutor, refusalFor, type FlowRunScope } from './builtins';
import { toolForNodeKind } from './nodes';
import type { FlowAuthority } from './authority';

/** What the bridge gives back. Structurally `AppCallResult` from `apps/bridge`. */
export interface FlowDispatchResult {
    ok: boolean;
    result?: unknown;
    error?: string;
}

/**
 * WHO is calling, as the dispatcher needs it.
 *
 * A `gapp` flow calls as its APP and is bounded by that app's grant. A `system`
 * or `workspace` flow calls as ITSELF, and its reach is read from its scope by
 * `resolveAgentTarget`. Two callers, one set of tools, no second implementation
 * of any of them.
 */
export type FlowCaller = { kind: 'app'; appId: string } | { kind: 'flow'; flowId: string };

/**
 * The way out to Genie's tools, as this module needs it.
 *
 * Injected rather than imported so the security decisions here are testable
 * without an Electron main process, and so there are exactly two
 * implementations in production — `dispatchAppCall` and `dispatchFlowCall` —
 * both of which end at the same `handleMcpMessage`.
 */
export type FlowDispatch = (
    caller: FlowCaller,
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
 * What this node actually IS, in the registry's own vocabulary.
 *
 * Two readings, in the order `runFlow` itself uses: `data.kind` is what an
 * editor writes and what a stored graph carries; `node.type` is the same value
 * for a node the canvas made, and the only reading for a hand-written one.
 * Whichever is found is then resolved THROUGH the registry, so an alias
 * (`branch`, `@fancy/branch`) and the canonical id (`@particle-academy/branch`)
 * become the same answer.
 *
 * Resolving rather than string-matching is what stops the door drifting: a kind
 * that gains an alias upstream keeps working, and a kind that is renamed stops
 * matching loudly instead of quietly falling through to a refusal that names the
 * wrong problem.
 */
export function canonicalKind(node: ExecutorCtx['node']): string | null {
    const declared = readString(node.data?.kind) ?? readString(node.type);
    if (!declared) return null;
    return getNodeKind(declared)?.name ?? declared;
}

/**
 * Build the executor registry for one flow run.
 *
 * The CALLER is closed over — that is the whole identity story, and it comes
 * from the run rather than from the graph. Everything else is decided per node,
 * by kind, at the one door below.
 */
export function buildFlowExecutors(
    caller: FlowCaller,
    dispatch: FlowDispatch,
): Record<string, Executor> {
    /**
     * Values `variable` steps have set, for this run only. Built here so it
     * cannot outlive the run or be shared with a concurrent one.
     */
    const scope: FlowRunScope = new Map();

    /** THE DOOR. */
    const door: Executor = async (ctx) => {
        const kind = canonicalKind(ctx.node);
        if (!kind) {
            return ctx.abort('This step has no kind, so Genie cannot tell what it would do.');
        }

        // 1. A Genie step. The ONLY branch that reaches Genie's tools, and it
        //    goes through the same gate a Genie App's window call goes through.
        const tool = toolForNodeKind(kind);
        if (tool) {
            const config = ctx.node.data?.config;
            const workspaceId =
                config && typeof config === 'object'
                    ? (readString((config as { workspaceId?: unknown }).workspaceId) ?? undefined)
                    : undefined;

            const outcome = await dispatch(caller, { tool, args: config, workspaceId });
            if (!outcome.ok) {
                return ctx.abort(outcome.error ?? `“${tool}” was refused.`);
            }
            return outcome.result;
        }

        // 2. A fancy-flow builtin Genie implements. Pure and local — it reaches
        //    no tool, so there is nothing for the bridge to decide.
        const builtin = builtinExecutor(kind);
        if (builtin) return builtin(ctx, scope);

        // 3. A builtin Genie deliberately does not run, said out loud.
        const refusal = refusalFor(kind);
        if (refusal) {
            return ctx.abort(`Genie does not run “${label(ctx)}” — ${refusal}`);
        }

        // 4. Something nobody has considered: a marketplace node, a kind from a
        //    newer package, a hand-edited graph. Refusing is the only safe
        //    reading of all three — a step Genie cannot account for stops the run.
        return ctx.abort(
            `Genie does not know how to run “${kind}”, so this flow stopped rather than ` +
                `skipping the step. Only Genie steps and the built-in logic steps can run here.`,
        );
    };

    // A wildcard-only registry. See the header: this is what makes the door
    // singular rather than merely conventional.
    return { '*': door };
}

/** How to name a step to someone looking at a canvas. */
function label(ctx: ExecutorCtx): string {
    return readString(ctx.node.data?.label) ?? canonicalKind(ctx.node) ?? 'this step';
}
