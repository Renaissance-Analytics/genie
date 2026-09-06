/**
 * The Flow model. PURE types — no I/O, no Electron, nothing to run.
 *
 * A **Flow is Genie's automation unit**, and there is exactly one kind:
 *
 *     Flow = a fancy-flow GRAPH (what runs) + Scope (who it belongs to)
 *
 * The graph carries its own triggers, as trigger NODES, so "when it runs" is
 * read off the document rather than stored beside it. Nothing in Genie has a
 * second answer to what a flow is.
 *
 * ## What used to be here, and why it is gone
 *
 * This module shipped in `v0.7.0-beta.298` as Wishes and was renamed to Flows by
 * v67. It carried its own engine: a recipe referenced by id, a trigger list, a
 * twelve-operator filter language, and a form of dropdowns to author it with.
 * Beside it — under the name `main/apps/flows/` — sat a second system built on
 * `@particle-academy/fancy-flow`, with a real graph document, a real executor
 * and a real canvas editor.
 *
 * They were the same idea built twice, and the hand-rolled one re-implemented,
 * worse, five things fancy-flow already ships: branching, filtering, iteration,
 * run checkpointing and human pause. So it is gone, and the graph system took
 * the name and the table (v74).
 *
 * What survives from it is the half fancy-flow does NOT provide, because nothing
 * in the package observes a host: the event registry, the producers that emit
 * events, the loop guard, and the run history. Those are below and in their own
 * modules.
 *
 * ## Scope is a field, not a rendering rule
 *
 * A GApp's flow appears in NO menu outside its GApp. That is a rule about the
 * model, so it lives in the model where every surface reads the same answer,
 * rather than in whichever menu happens to be drawing itself.
 *
 * It is NOISE REDUCTION, not a security boundary (genie#394): it keeps an
 * agent's reasoning clear of automation it has no business acting on. Nothing
 * security-bearing may be built on top of it — what a flow may DO is decided by
 * `decideFlowAdmission` and `decideAppCall`, which read the grant, not the scope.
 */

/* ===== events ========================================================== */

/** The only value types an event prop may carry, so a filter can be total. */
export type FlowPropValue = string | number | boolean;

export type FlowPropType = 'string' | 'number' | 'boolean';

/** One prop an event kind promises to emit. */
export interface FlowPropDefinition {
    key: string;
    type: FlowPropType;
    label: string;
    description?: string;
}

/**
 * An event kind, as a registry ENTRY. Adding one is adding a value to a list —
 * there is deliberately no place in the matcher or the dispatcher that has to
 * learn about it (proved by `__tests__/extensible-events.test.ts`).
 */
export interface FlowEventDefinition {
    /** Namespaced id, e.g. `<domain>:<past-tense-verb>`. Unique per registry. */
    id: string;
    label: string;
    /** Default grouping for the menu. */
    purpose?: string;
    props: readonly FlowPropDefinition[];
}

/**
 * Where an event came from — the loop-prevention primitive.
 *
 * `agent-bridge` solves the same problem in a different domain with a `source`
 * field on every message, and the reason it generalises is that a loop is not a
 * property of any one event: it is a property of the CHAIN an event belongs to.
 * A source carries the chain (which flow run, how deep), so a cycle is
 * detectable at the point of admission rather than after it has already run
 * twice. See `loop.ts`.
 */
export type FlowEventSource =
    | { kind: 'system' }
    | { kind: 'user' }
    | { kind: 'flow'; flowId: string; runId: string; depth: number };

/** A thing that happened, described entirely by its kind and its props. */
export interface FlowEvent {
    event: string;
    props: Readonly<Record<string, FlowPropValue>>;
    source: FlowEventSource;
    /** Epoch ms. Defaulted by the dispatcher when absent. */
    at?: number;
}

/**
 * An effect a run is ABOUT to cause, declared before it happens.
 *
 * A flow that writes a file will be reported back by the watcher as a brand-new
 * file, with no idea who made it. Declaring the effect first is what lets the
 * dispatcher recognise the echo when it arrives out of band — see `loop.ts`.
 */
export interface FlowDeclaredEffect {
    event: string;
    /** Props the echoing event will carry. A subset is enough to match on. */
    match: Readonly<Record<string, FlowPropValue>>;
}

/* ===== scope =========================================================== */

/**
 * Who the Flow belongs to and who may see it. One ladder, three rungs.
 *
 *  - `system`    — the whole machine. Every event reaches it and every surface
 *                  lists it.
 *  - `workspace` — one workspace. It only ever sees events carrying that
 *                  workspace's id, so a Flow cannot silently act on another
 *                  project's files.
 *  - `gapp`      — a GApp owns it. It appears in NO menu outside that GApp, and
 *                  it acts under that app's grant.
 *
 * **A GApp flow is a flow whose scope is `gapp`.** It is not a separate system,
 * it has no separate table, no separate runner and no separate editor — which is
 * what the two-system split got wrong and what v74 undid.
 */
export type FlowScope =
    | { kind: 'system' }
    | { kind: 'workspace'; workspaceId: string }
    | { kind: 'gapp'; appId: string };

export type FlowScopeKind = FlowScope['kind'];

/** The app whose grant a flow acts under, or null for a user-owned flow. */
export function owningAppOf(scope: FlowScope): string | null {
    return scope.kind === 'gapp' ? scope.appId : null;
}

/**
 * Read a stored scope, or null when it is not one.
 *
 * A row can be hand-edited or migrated from a shape that no longer parses.
 * Whatever is listing flows must not fall over because one of them is corrupt,
 * so an unreadable scope reads back as null and the flow is refused downstream
 * rather than being run under a guessed scope.
 */
export function parseFlowScope(raw: unknown): FlowScope | null {
    if (!raw || typeof raw !== 'object') return null;
    const scope = raw as { kind?: unknown; workspaceId?: unknown; appId?: unknown };
    if (scope.kind === 'system') return { kind: 'system' };
    if (scope.kind === 'workspace' && typeof scope.workspaceId === 'string' && scope.workspaceId !== '') {
        return { kind: 'workspace', workspaceId: scope.workspaceId };
    }
    if (scope.kind === 'gapp' && typeof scope.appId === 'string' && scope.appId !== '') {
        return { kind: 'gapp', appId: scope.appId };
    }
    return null;
}

/* ===== runs ============================================================ */

/**
 * How a run ended.
 *
 * Only `ran` means the graph did its job. `blocked`, `refused` and `handoff` are
 * the system DECLINING to act, often correctly — but none of them is a flow that
 * worked, and collapsing them into one word is how a run list becomes decoration.
 */
export type FlowRunOutcome = 'ran' | 'failed' | 'blocked' | 'refused' | 'handoff' | 'error';

export interface FlowRunStart {
    flowId: string;
    runId: string;
    /** The event that selected it; absent on a manual run. */
    event?: string;
    /** Epoch ms. */
    at: number;
}

export interface FlowRunLog {
    flowId: string;
    runId: string;
    /** The event that selected it; absent on a manual run. */
    event?: string;
    outcome: FlowRunOutcome;
    reason?: string;
    /** Node-level refusals from admission, when that is why it did not run. */
    refusals?: { nodeId: string; label?: string; reason: string }[];
    at: number;
}
