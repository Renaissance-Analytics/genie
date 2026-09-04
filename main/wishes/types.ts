/**
 * The Wish model. PURE types — no I/O, no Electron, nothing to run.
 *
 * A **Wish is a request that MAY carry a runnable workflow.** In Tynn "Wish"
 * meant quick idea capture; in Genie it IS the Workflow, and the name was moved
 * deliberately (owner decision, `.ai/plans/wishes-issues-and-the-osa.md`).
 *
 *     Wish = Recipe (what runs) + Trigger (when) + Scope (who sees it)
 *
 * ## The body is a Recipe, and there is only one recipe engine
 *
 * `renderer/lib/recipes/` is already a step engine driving the workstation setup
 * wizard, and a Wish's body is one of its Recipes. Nothing here re-implements
 * it. What this module adds is the half that did not exist: WHEN a recipe runs
 * and WHO may see it.
 *
 * The recipe is referenced by id rather than inlined, for the same reason a
 * plugin recipe manifest is the SERIALIZABLE subset of the Recipe API
 * (`main/plugins/manifest.ts`): a stored Wish is JSON, and a JSON row cannot
 * carry `task.run`. An id resolves to a first-party in-code recipe whose effects
 * were reviewed at build time — which is also what makes an UNATTENDED run
 * defensible at all (see `admission.ts`).
 *
 * ## Scope is a field, not a rendering rule
 *
 * A GApp Wish is either workstation-exposed or internal-only, and an internal
 * one appears in NO menu outside its GApp. That is an authorisation rule, so it
 * lives in the model where every surface reads the same answer, rather than in
 * whichever menu happens to be drawing itself.
 */

import type { PluginRecipeStep } from '../plugins/manifest';

/* ===== events ========================================================== */

/** The only value types an event prop may carry, so a filter can be total. */
export type WishPropValue = string | number | boolean;

export type WishPropType = 'string' | 'number' | 'boolean';

/** One prop an event kind promises to emit. The filter surface is exactly this. */
export interface WishPropDefinition {
    key: string;
    type: WishPropType;
    label: string;
    description?: string;
}

/**
 * An event kind, as a registry ENTRY. Adding one is adding a value to a list —
 * there is deliberately no place in the matcher, filter or dispatcher that has
 * to learn about it (proved by `__tests__/extensible-events.test.ts`).
 */
export interface WishEventDefinition {
    /** Namespaced id, e.g. `<domain>:<past-tense-verb>`. Unique per registry. */
    id: string;
    label: string;
    /** Default grouping for the (deferred) menu. */
    purpose?: string;
    props: readonly WishPropDefinition[];
}

/**
 * Where an event came from — the loop-prevention primitive.
 *
 * `agent-bridge` solves the same problem in a different domain with a `source`
 * field on every message, and the reason it generalises is that a loop is not a
 * property of any one event: it is a property of the CHAIN an event belongs to.
 * A source carries the chain (which wish run, how deep), so a cycle is
 * detectable at the point of admission rather than after it has already run
 * twice. See `loop.ts`.
 */
export type WishEventSource =
    | { kind: 'system' }
    | { kind: 'user' }
    | { kind: 'wish'; wishId: string; runId: string; depth: number };

/** A thing that happened, described entirely by its kind and its props. */
export interface WishEvent {
    event: string;
    props: Readonly<Record<string, WishPropValue>>;
    source: WishEventSource;
    /** Epoch ms. Defaulted by the runtime when absent. */
    at?: number;
}

/* ===== filters ========================================================= */

export type WishFilterOp =
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
export interface WishFilterClause {
    prop: string;
    op: WishFilterOp;
    value: WishPropValue | readonly WishPropValue[];
}

/**
 * A predicate over an event's props. Every group present must hold, so
 * `{ all, none }` reads as "these, but not those" — which is what the reference
 * case needs to say (over 5 MB, but not already inside the folder we move to).
 */
export interface WishFilter {
    all?: readonly WishFilterClause[];
    any?: readonly WishFilterClause[];
    none?: readonly WishFilterClause[];
}

/* ===== triggers, scope, the Wish ======================================= */

/** A human asked for it. The only trigger tied to a request. */
export interface WishManualTrigger {
    kind: 'manual';
}

/** Something happened. `filter` is a predicate over the event's declared props. */
export interface WishEventTrigger {
    kind: 'event';
    event: string;
    filter?: WishFilter;
}

export type WishTrigger = WishManualTrigger | WishEventTrigger;

/**
 * Who the Wish belongs to and who may see it.
 *
 *  - `workstation` — everything on this machine; every event reaches it.
 *  - `workspace`   — one workspace. It only ever sees events carrying that
 *                    workspace's id, so a Wish cannot silently act on another
 *                    project's files.
 *  - `app`         — a GApp authored it. `exposure: 'internal'` means it appears
 *                    in NO menu outside that GApp, and an agent may only use it
 *                    if the GApp's `agent.md` declares it.
 */
export type WishScope =
    | { kind: 'workstation' }
    | { kind: 'workspace'; workspaceId: string }
    | { kind: 'app'; appId: string; exposure: 'workstation' | 'internal' };

/** How to find the Wish's body. */
export interface WishRecipeRef {
    kind: 'builtin';
    recipeId: string;
    /** Seed values written into the run context before the first step. */
    args?: Readonly<Record<string, WishPropValue>>;
}

export interface Wish {
    id: string;
    title: string;
    /**
     * What the Wish is FOR. The menu groups by this, so it is a stored field
     * rather than something inferred from the title — design note 4 of
     * `.ai/_discovery/genie-wish-triggers.md`.
     */
    purpose: string;
    scope: WishScope;
    /** At least one. Manual and event triggers mix freely. */
    triggers: readonly WishTrigger[];
    recipe: WishRecipeRef;
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
export interface WishDeclaredEffect {
    event: string;
    /** Props the echoing event will carry. A subset is enough to match on. */
    match: Readonly<Record<string, WishPropValue>>;
}

/** Shared state for one run, plus the seams a task uses to stay loop-free. */
export interface WishRunContext {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    /** Declare an effect BEFORE causing it. */
    declareEffect(effect: WishDeclaredEffect): void;
    /**
     * Announce something this run did, so other Wishes can react to it.
     *
     * The source is filled in by the runtime — a task cannot claim to be
     * somebody else, and cannot reset the chain's depth to escape the loop
     * guard. That is the whole reason this exists rather than a task reaching
     * for the dispatcher directly.
     */
    emit(event: Pick<WishEvent, 'event' | 'props'>): Promise<void>;
    readonly wishId: string;
    readonly runId: string;
    /** The event that triggered this run; absent on a manual run. */
    readonly event?: WishEvent;
}

/**
 * A first-party step whose effect is in-repo code rather than a shell command.
 * The one step type an unattended run may execute (see `admission.ts`).
 */
export interface WishTaskStep {
    type: 'task';
    id: string;
    title: string;
    run: (ctx: WishRunContext) => Promise<void>;
}

/**
 * A Wish's body. The serializable steps are exactly `PluginRecipeStep` — the
 * shape main already uses for a declared recipe — so a Wish and a plugin recipe
 * cannot drift into two different notions of "a form step".
 */
export type WishRecipeStep = PluginRecipeStep | WishTaskStep;

export interface WishRecipe {
    id: string;
    title: string;
    steps: readonly WishRecipeStep[];
}
