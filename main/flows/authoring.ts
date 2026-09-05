/**
 * PURE. Turning a draft into a Flow, and refusing the ones that could not work.
 *
 * Phase 1 shipped a complete Flow model that nothing could create
 * (genie#394). This is the other half: what a surface — or an agent — hands in,
 * what comes back, and every reason a Flow is refused before it is stored.
 *
 * ## A new Flow is born disarmed, and that is decided HERE
 *
 * Arming a Flow hands it standing permission to act unattended, and Genie asks
 * before that happens, in the recipe's own words ("Moves files out of your
 * workspace…"). Creation must not be a second door onto the same thing, so
 * {@link FlowDraft} has no `enabled` field at all and {@link buildFlow} writes
 * `false` for anything new. A renderer cannot forget it and a hand-written IPC
 * payload cannot ask for otherwise.
 *
 * The same reasoning covers EDITING an armed Flow. The confirmation stated two
 * things — what the body does, and where it may act — so a change to either
 * leaves consent that no longer describes the Flow. Both disarm it, and say so.
 * Its triggers and its title are not part of that sentence and do not.
 *
 * ## Everything a body needs is DECLARED, so one form serves every recipe
 *
 * A recipe declares its {@link FlowRecipeInput}s. That is what lets the
 * authoring surface render fields for a second recipe it has never heard of,
 * and — more importantly — what lets this module refuse, at the write, a Flow
 * whose body could never run:
 *
 *  - a manual trigger on a body that reads its file off the event, with no
 *    value beside it: a Run button that can only ever throw;
 *  - an event trigger whose event does not carry a prop the body reads;
 *  - a setting the recipe does not have (the misspelling case);
 *  - an event trigger on a body no unattended run may execute — armed, fires
 *    nightly, refused every time, and looks perfectly healthy in a list.
 *
 * Refusing late is the failure this whole module exists to prevent, and it is
 * the same rule `store.ts` already states for a trigger nothing emits.
 */

import { decideFlowAdmission, type FlowStepRefusal } from './admission';
import type { FlowEventRegistry } from './events';
import { validateFlowFilter } from './filter';
import { needsWizard } from './recipe';
import type {
    Flow,
    FlowPropValue,
    FlowRecipe,
    FlowRecipeInput,
    FlowRecipeRef,
    FlowScope,
    FlowTrigger,
} from './types';

/**
 * How a Flow's stored reference is turned into the body it names.
 *
 * Taken as a parameter rather than imported, so the catalogue a Flow is JUDGED
 * against is the same one the runtime will RESOLVE against — `index.ts` hands
 * both the same function. Validating against a different set of recipes than
 * the dispatcher runs would accept Flows that can never fire, which is the one
 * thing this gate exists to prevent.
 */
export type FlowRecipeResolver = (ref: FlowRecipeRef) => FlowRecipe | null;

/* ===== what a surface is handed ======================================== */

/**
 * A recipe as an authoring surface sees it: SERIALIZABLE.
 *
 * A `FlowRecipe` carries `run` functions, so it cannot cross IPC. This is the
 * subset that can — the same reason a plugin recipe manifest is the
 * serializable subset of the Recipe API (`main/plugins/manifest.ts`).
 */
export interface FlowRecipeSummary {
    id: string;
    title: string;
    /** What arming a Flow with this body will DO, in the recipe's own words. */
    consequence?: string;
    /** The default grouping for a Flow built from it. */
    purpose?: string;
    inputs: FlowRecipeInput[];
    /** False when an event trigger could never run this body. */
    runsUnattended: boolean;
    /** Why not, step by step. Empty when it can. */
    unattendedRefusals: FlowStepRefusal[];
    /** True when a manual run hands off to the renderer's recipe wizard. */
    needsWizard: boolean;
}

/**
 * What a caller hands in to create or edit a Flow.
 *
 * Deliberately NOT a `Flow`: it has no `enabled` (see the header) and no
 * `purpose` is required, because a purpose is Genie's grouping vocabulary and
 * making a person invent one is how a menu ends up with six groups of one.
 */
export interface FlowDraft {
    /** Absent to create; the id of the Flow being edited otherwise. */
    id?: string;
    title: string;
    /** Overrides {@link suggestFlowPurpose}. Rarely worth setting. */
    purpose?: string;
    description?: string;
    scope: FlowScope;
    triggers: readonly FlowTrigger[];
    recipeId: string;
    /** Standing values for the recipe's inputs. */
    args?: Readonly<Record<string, FlowPropValue>>;
}

export interface BuildFlowOptions {
    /** The stored Flow this draft edits. Absent when creating. */
    existing?: Flow | null;
    /** Ids already in use, so a new Flow cannot land on one. */
    taken?: ReadonlySet<string>;
}

export interface FlowBuildResult {
    flow: Flow;
    /**
     * An armed Flow was turned OFF by this edit, because what it does or where
     * it may act changed. The surface says so rather than letting a switch
     * silently flip.
     */
    disarmed: boolean;
}

/* ===== the catalogue =================================================== */

export function summariseFlowRecipe(recipe: FlowRecipe): FlowRecipeSummary {
    const admission = decideFlowAdmission(recipe, 'unattended');
    return {
        id: recipe.id,
        title: recipe.title,
        ...(recipe.consequence ? { consequence: recipe.consequence } : {}),
        ...(recipe.purpose ? { purpose: recipe.purpose } : {}),
        inputs: [...(recipe.inputs ?? [])],
        runsUnattended: admission.ok,
        unattendedRefusals: admission.refusals,
        needsWizard: needsWizard(recipe),
    };
}

/** Every body a surface may offer, id-sorted so the list is stable. */
export function summariseFlowRecipes(recipes: Iterable<FlowRecipe>): FlowRecipeSummary[] {
    return [...recipes]
        .map(summariseFlowRecipe)
        .sort((a, b) => a.id.localeCompare(b.id));
}

/* ===== ids ============================================================= */

const MAX_ID_LENGTH = 48;

/**
 * A readable id built from the title.
 *
 * Not a uuid. A Flow's id turns up in run history, in `[flows]` log lines and in
 * the loop guard's chain, and `keep-the-repo-light` tells whoever is reading one
 * of those what they are looking at where `wf-8c1a2e` does not.
 */
export function newFlowId(title: string, taken: ReadonlySet<string> = new Set()): string {
    const base =
        title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, MAX_ID_LENGTH)
            .replace(/-+$/g, '') || `flow-${Date.now().toString(36)}`;

    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        const candidate = `${base}-${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/* ===== the draft becomes a Flow ======================================== */

/** Whether two scopes name the same thing, without depending on key order. */
function sameScope(a: FlowScope, b: FlowScope): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'workspace' && b.kind === 'workspace') {
        return a.workspaceId === b.workspaceId;
    }
    if (a.kind === 'gapp' && b.kind === 'gapp') return a.appId === b.appId;
    return true;
}

/**
 * Build the Flow this draft describes.
 *
 * Does NOT validate — `validateFlow` does, against the event registry and the
 * recipe, and it must judge the same object that would be stored rather than a
 * draft that still has defaults to apply.
 */
export function buildFlow(draft: FlowDraft, opts: BuildFlowOptions = {}): FlowBuildResult {
    const existing = draft.id ? (opts.existing ?? null) : null;
    const id = draft.id ?? newFlowId(draft.title, opts.taken);

    const recipe = {
        kind: 'builtin' as const,
        recipeId: draft.recipeId,
        ...(draft.args && Object.keys(draft.args).length > 0 ? { args: { ...draft.args } } : {}),
    };

    // What the arm confirmation stated: what the body does, and where it acts.
    // Change either and the consent it recorded no longer describes this Flow.
    const rewritten =
        existing !== null &&
        (existing.recipe.recipeId !== recipe.recipeId ||
            !sameScope(existing.scope, draft.scope));
    const disarmed = rewritten && existing.enabled;

    return {
        flow: {
            id,
            title: draft.title.trim(),
            purpose: (draft.purpose ?? '').trim(),
            ...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
            scope: draft.scope,
            triggers: [...draft.triggers],
            recipe,
            // A new Flow is OFF. Never read from the draft — there is nothing
            // to read, deliberately.
            enabled: existing !== null && !disarmed ? existing.enabled : false,
        },
        disarmed,
    };
}

/**
 * What to group this Flow under when the draft does not say.
 *
 * The trigger's own grouping first: a Flow that fires on a file event belongs
 * beside the other file automation, whatever its body happens to be. Then the
 * recipe's. Never empty — `validateFlow` refuses a Flow with no purpose, and
 * returning `''` here would turn a defaulting decision into a save error.
 */
export function suggestFlowPurpose(
    recipe: FlowRecipeSummary | null,
    triggers: readonly FlowTrigger[],
    registry: FlowEventRegistry,
): string {
    for (const trigger of triggers) {
        if (trigger.kind !== 'event') continue;
        const purpose = registry.get(trigger.event)?.purpose;
        if (purpose) return purpose;
    }
    return recipe?.purpose || 'Flows';
}

/* ===== refusing a Flow whose body could never run ====================== */

/** How a trigger reads in an error, so the author knows which one to fix. */
function triggerName(trigger: FlowTrigger, registry: FlowEventRegistry): string {
    if (trigger.kind === 'manual') return 'a Flow you run by hand';
    return `"${registry.get(trigger.event)?.label ?? trigger.event}" (${trigger.event})`;
}

/** True when the event kind this trigger names carries `input` as a prop. */
function eventSupplies(
    trigger: FlowTrigger,
    input: FlowRecipeInput,
    registry: FlowEventRegistry,
): boolean {
    if (trigger.kind !== 'event' || input.fromEvent !== true) return false;
    const prop = registry.get(trigger.event)?.props.find((p) => p.key === input.key);
    return prop !== undefined && prop.type === input.type;
}

/**
 * Everything about this Flow's BODY that would stop it working, all of it at
 * once — an author fixing a Flow wants the whole list, not four rounds.
 *
 * Called by `validateFlow`, so it runs on every write from every caller. The
 * recipe arrives already summarised because the same judgement has to be
 * available to a surface that only ever sees the serializable form.
 */
export function recipeErrors(
    flow: Flow,
    recipe: FlowRecipeSummary,
    registry: FlowEventRegistry,
): string[] {
    const errors: string[] = [];
    const declared = new Map(recipe.inputs.map((i) => [i.key, i]));
    const args = flow.recipe.args ?? {};

    for (const [key, value] of Object.entries(args)) {
        const input = declared.get(key);
        if (!input) {
            errors.push(
                `"${recipe.id}" has no setting called "${key}" ` +
                    `(it reads ${recipe.inputs.map((i) => i.key).join(', ') || 'nothing'}).`,
            );
            continue;
        }
        if (typeof value !== input.type) {
            errors.push(
                `the setting "${key}" is a ${input.type}; this Flow gives a ${typeof value}.`,
            );
        }
    }

    // A body that cannot run unattended, on a trigger that fires unattended.
    // Saving it produces a Flow that is armed, fires, and is refused every
    // single time -- with nothing in the list looking wrong.
    if (!recipe.runsUnattended && flow.triggers.some((t) => t.kind === 'event')) {
        const why = recipe.unattendedRefusals
            .map((r) => `"${r.stepId}" (${r.stepType}) — ${r.reason}`)
            .join(' ');
        errors.push(
            `"${recipe.id}" cannot run with nobody present, and an event trigger fires ` +
                `with nobody present, so this Flow would be refused every time. ${why}`,
        );
    }

    for (const input of recipe.inputs) {
        if (input.required !== true) continue;
        // A standing value or a default satisfies it for every trigger at once.
        if (Object.prototype.hasOwnProperty.call(args, input.key)) continue;
        if (input.default !== undefined) continue;

        for (const trigger of flow.triggers) {
            if (eventSupplies(trigger, input, registry)) continue;
            errors.push(
                `"${recipe.id}" needs "${input.label}" (${input.key}), and ` +
                    `${triggerName(trigger, registry)} supplies none. Give the Flow a value ` +
                    `for it, or trigger on an event that carries it.`,
            );
        }
    }

    return errors;
}

/* ===== one save, decided in one place ================================== */

export interface FlowSavePlanDeps {
    registry: FlowEventRegistry;
    resolveRecipe: FlowRecipeResolver;
    /** The stored Flow this draft edits. `null` when the draft names one that is gone. */
    existing?: Flow | null;
    /** Ids already in use, so a new Flow cannot land on one. */
    taken?: ReadonlySet<string>;
}

export type FlowSavePlan =
    | { ok: true; flow: Flow; disarmed: boolean }
    | { ok: false; errors: string[] };

/**
 * Everything a save decides, with no database in sight.
 *
 * The defaulting, the disarm rule and the validation belong together — a caller
 * that did them in its own order would eventually validate a draft rather than
 * the Flow that gets stored, and the gap between those two is where a Flow
 * nobody consented to gets written. `index.ts` supplies the rows and performs
 * the write; every judgement is here.
 */
export function planFlowSave(draft: FlowDraft, deps: FlowSavePlanDeps): FlowSavePlan {
    // An edit whose Flow has been deleted underneath it — two managers open, one
    // of them deleted. Saving would resurrect it as a NEW row, disarmed and
    // subtly not the thing the other window thought it was editing.
    if (draft.id && !deps.existing) {
        return {
            ok: false,
            errors: [`there is no Flow "${draft.id}" any more — it may have been deleted.`],
        };
    }

    const recipe = deps.resolveRecipe({ kind: 'builtin', recipeId: draft.recipeId });
    const purpose =
        draft.purpose?.trim() ||
        suggestFlowPurpose(
            recipe ? summariseFlowRecipe(recipe) : null,
            draft.triggers,
            deps.registry,
        );

    const built = buildFlow(
        { ...draft, purpose },
        { existing: deps.existing ?? null, taken: deps.taken },
    );

    // The FLOW is validated, not the draft: what is judged has to be what is
    // stored, defaults included.
    const errors = validateFlow(built.flow, deps.registry, deps.resolveRecipe);
    if (errors.length > 0) return { ok: false, errors };

    return { ok: true, flow: built.flow, disarmed: built.disarmed };
}

/* ===== the write gate ================================================== */

/**
 * Everything wrong with this Flow, in one list.
 *
 * All the problems rather than the first: an author fixing a Flow wants the
 * whole list, and reporting one at a time turns a single edit into four rounds.
 */
export function validateFlow(
    flow: Flow,
    registry: FlowEventRegistry,
    resolveRecipe: FlowRecipeResolver,
): string[] {
    const errors: string[] = [];

    if (!nonEmpty(flow.id)) errors.push('a Flow needs an id.');
    if (!nonEmpty(flow.title)) errors.push('a Flow needs a title.');
    if (!nonEmpty(flow.purpose)) {
        errors.push('a Flow needs a purpose — the menu groups by it, so it cannot be inferred.');
    }
    if (!flow.recipe || flow.recipe.kind !== 'builtin' || !nonEmpty(flow.recipe.recipeId)) {
        errors.push('a Flow needs a body: a recipe id.');
    } else {
        // The body is judged HERE, not only when it runs. A Flow pointing at a
        // recipe that does not exist, or one whose inputs nothing supplies, is
        // refused every time it fires — and looks completely healthy in a list
        // while doing it. See `authoring.ts`.
        const recipe = resolveRecipe(flow.recipe);
        if (!recipe) {
            errors.push(
                `no body called "${flow.recipe.recipeId}" is installed, so nothing would run.`,
            );
        } else {
            errors.push(...recipeErrors(flow, summariseFlowRecipe(recipe), registry));
        }
    }

    errors.push(...scopeErrors(flow.scope));

    if (!Array.isArray(flow.triggers) || flow.triggers.length === 0) {
        errors.push('a Flow needs at least one trigger, or nothing could ever start it.');
    } else {
        flow.triggers.forEach((trigger, i) => {
            errors.push(...triggerErrors(trigger, i, registry));
        });
    }

    return errors;
}

function nonEmpty(v: unknown): boolean {
    return typeof v === 'string' && v.trim() !== '';
}

function scopeErrors(scope: FlowScope | undefined): string[] {
    if (!scope || typeof scope !== 'object') return ['a Flow needs a scope.'];
    switch (scope.kind) {
        case 'system':
            return [];
        case 'workspace':
            return nonEmpty(scope.workspaceId)
                ? []
                : ['a workspace-scoped Flow needs a workspaceId.'];
        case 'gapp':
            // The appId is the whole of a `gapp` scope: it says who owns the
            // Flow AND who may see it. Without one the Flow belongs to nobody
            // and appears to nobody.
            return nonEmpty(scope.appId) ? [] : ['a gapp-scoped Flow needs an appId.'];
        default:
            return [`unknown scope "${String((scope as { kind?: unknown }).kind)}".`];
    }
}

function triggerErrors(trigger: FlowTrigger, i: number, registry: FlowEventRegistry): string[] {
    const where = `triggers[${i}]`;
    if (!trigger || typeof trigger !== 'object') return [`${where} is not a trigger.`];
    if (trigger.kind === 'manual') return [];
    if (trigger.kind !== 'event') {
        return [`${where}: unknown trigger kind "${String((trigger as { kind?: unknown }).kind)}".`];
    }
    const def = registry.get(trigger.event);
    if (!def) {
        return [
            `${where}: nothing emits "${trigger.event}". ` +
                `Known events: ${registry.list().map((d) => d.id).join(', ') || '(none)'}.`,
        ];
    }
    return validateFlowFilter(trigger.filter, def).map((e) => `${where}: ${e}`);
}
