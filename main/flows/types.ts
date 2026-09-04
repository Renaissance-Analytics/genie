/**
 * The Flow model. PURE types — no I/O, no Electron, nothing to run.
 *
 * A **Flow is Genie's automation unit** (genie#394,
 * `.ai/plans/genie-flows-unification.md`):
 *
 *     Flow = Recipe (what runs) + Trigger (when) + Scope (who sees it)
 *
 * This module shipped in `v0.7.0-beta.298` under the name **Wishes**, which was
 * always the Tynn word for quick idea capture wearing a second hat. Genie's
 * automation is called Flows, at every scope, so the name went back to Tynn and
 * this became what it is. Released notes still say Wishes; they are history.
 *
 * ## The body is a Recipe, and there is only one recipe engine
 *
 * `renderer/lib/recipes/` is already a step engine driving the workstation setup
 * wizard, and a Flow's body is one of its Recipes. Nothing here re-implements
 * it. What this module adds is the half that did not exist: WHEN a recipe runs
 * and WHO may see it.
 *
 * The recipe is referenced by id rather than inlined, for the same reason a
 * plugin recipe manifest is the SERIALIZABLE subset of the Recipe API
 * (`main/plugins/manifest.ts`): a stored Flow is JSON, and a JSON row cannot
 * carry `task.run`. An id resolves to a first-party in-code recipe whose effects
 * were reviewed at build time — which is also what makes an UNATTENDED run
 * defensible at all (see `admission.ts`).
 *
 * ## Scope is a field, not a rendering rule
 *
 * A GApp's Flow appears in NO menu outside its GApp. That is a rule about the
 * model, so it lives in the model where every surface reads the same answer,
 * rather than in whichever menu happens to be drawing itself.
 *
 * It is NOISE REDUCTION, not a security boundary (genie#394): it keeps an
 * agent's reasoning clear of automation it has no business acting on. Nothing
 * security-bearing may be built on top of it.
 */

import type { PluginRecipeStep } from '../plugins/manifest';

/* ===== events ========================================================== */

/** The only value types an event prop may carry, so a filter can be total. */
export type FlowPropValue = string | number | boolean;

export type FlowPropType = 'string' | 'number' | 'boolean';

/** One prop an event kind promises to emit. The filter surface is exactly this. */
export interface FlowPropDefinition {
    key: string;
    type: FlowPropType;
    label: string;
    description?: string;
}

/**
 * An event kind, as a registry ENTRY. Adding one is adding a value to a list —
 * there is deliberately no place in the matcher, filter or dispatcher that has
 * to learn about it (proved by `__tests__/extensible-events.test.ts`).
 */
export interface FlowEventDefinition {
    /** Namespaced id, e.g. `<domain>:<past-tense-verb>`. Unique per registry. */
    id: string;
    label: string;
    /** Default grouping for the (deferred) menu. */
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
    /** Epoch ms. Defaulted by the runtime when absent. */
    at?: number;
}

/* ===== filters ========================================================= */

export type FlowFilterOp =
    | 'eq'
    | 'ne'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'matches'
    | 'startsWith'
    | 'endsWith'
    | 'contains'
    | 'in'
    | 'notIn';

/** One predicate over one declared prop. */
export interface FlowFilterClause {
    prop: string;
    op: FlowFilterOp;
    value: FlowPropValue | readonly FlowPropValue[];
}

/**
 * A predicate over an event's props. Every group present must hold, so
 * `{ all, none }` reads as "these, but not those" — which is what the reference
 * case needs to say (over 5 MB, but not already inside the folder we move to).
 */
export interface FlowFilter {
    all?: readonly FlowFilterClause[];
    any?: readonly FlowFilterClause[];
    none?: readonly FlowFilterClause[];
}

/* ===== triggers, scope, the Flow ======================================= */

/** A human asked for it. The only trigger tied to a request. */
export interface FlowManualTrigger {
    kind: 'manual';
}

/** Something happened. `filter` is a predicate over the event's declared props. */
export interface FlowEventTrigger {
    kind: 'event';
    event: string;
    filter?: FlowFilter;
}

export type FlowTrigger = FlowManualTrigger | FlowEventTrigger;

/**
 * Who the Flow belongs to and who may see it. One ladder, three rungs
 * (owner decision, genie#394).
 *
 *  - `system`    — the whole machine. Every event reaches it and every surface
 *                  lists it.
 *  - `workspace` — one workspace. It only ever sees events carrying that
 *                  workspace's id, so a Flow cannot silently act on another
 *                  project's files.
 *  - `gapp`      — a GApp owns it. It appears in NO menu outside that GApp, and
 *                  an agent may only use it if the GApp's `agent.md` declares
 *                  it.
 *
 * ## Why there is no `exposure`
 *
 * v66 shipped a fourth thing: an `app` scope carrying
 * `exposure: 'workstation' | 'internal'`, deciding whether a GApp's Flow
 * appeared outside its GApp. The scope and the exposure were saying the same
 * word twice — and two fields that must agree are two fields that eventually
 * do not. **A `gapp` scope IS internal.** A GApp Flow meant to be seen
 * machine-wide is a `system` Flow; publishing outward is a decision made when
 * the GApp is installed, the way a capability is, not a flag on the Flow.
 *
 * What that costs is knowing which GApp authored a published Flow, and reaping
 * it when that GApp is uninstalled. Neither was ever built — v66 deliberately
 * declined the app foreign key and the cascade — so nothing regresses. When
 * GApp-authored Flows become creatable (genie#394 phase 2) that ownership is a
 * COLUMN to add, not a fourth scope: who owns a Flow and who may see it are
 * different questions, and v66 answered them with one field.
 */
export type FlowScope =
    | { kind: 'system' }
    | { kind: 'workspace'; workspaceId: string }
    | { kind: 'gapp'; appId: string };

/** How to find the Flow's body. */
export interface FlowRecipeRef {
    kind: 'builtin';
    recipeId: string;
    /** Seed values written into the run context before the first step. */
    args?: Readonly<Record<string, FlowPropValue>>;
}

export interface Flow {
    id: string;
    title: string;
    /**
     * What the Flow is FOR. The menu groups by this, so it is a stored field
     * rather than something inferred from the title — design note 4 of
     * `.ai/_discovery/genie-wish-triggers.md`.
     */
    purpose: string;
    scope: FlowScope;
    /** At least one. Manual and event triggers mix freely. */
    triggers: readonly FlowTrigger[];
    recipe: FlowRecipeRef;
    enabled: boolean;
    description?: string;
}

/* ===== the runnable body =============================================== */

/**
 * An effect a run is ABOUT to cause, declared before it happens.
 *
 * The file-move reference case writes a file, and the file watcher will report
 * that write as a brand-new file with no idea who made it. Declaring the effect
 * first is what lets the runtime recognise the echo when it arrives out of band
 * — see `loop.ts`.
 */
export interface FlowDeclaredEffect {
    event: string;
    /** Props the echoing event will carry. A subset is enough to match on. */
    match: Readonly<Record<string, FlowPropValue>>;
}

/** Shared state for one run, plus the seams a task uses to stay loop-free. */
export interface FlowRunContext {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    /** Declare an effect BEFORE causing it. */
    declareEffect(effect: FlowDeclaredEffect): void;
    /**
     * Announce something this run did, so other Flows can react to it.
     *
     * The source is filled in by the runtime — a task cannot claim to be
     * somebody else, and cannot reset the chain's depth to escape the loop
     * guard. That is the whole reason this exists rather than a task reaching
     * for the dispatcher directly.
     */
    emit(event: Pick<FlowEvent, 'event' | 'props'>): Promise<void>;
    readonly flowId: string;
    readonly runId: string;
    /** The event that triggered this run; absent on a manual run. */
    readonly event?: FlowEvent;
}

/**
 * A first-party step whose effect is in-repo code rather than a shell command.
 * The one step type an unattended run may execute (see `admission.ts`).
 */
export interface FlowTaskStep {
    type: 'task';
    id: string;
    title: string;
    run: (ctx: FlowRunContext) => Promise<void>;
}

/**
 * A Flow's body. The serializable steps are exactly `PluginRecipeStep` — the
 * shape main already uses for a declared recipe — so a Flow and a plugin recipe
 * cannot drift into two different notions of "a form step".
 */
export type FlowRecipeStep = PluginRecipeStep | FlowTaskStep;

export interface FlowRecipe {
    id: string;
    title: string;
    steps: readonly FlowRecipeStep[];
}
