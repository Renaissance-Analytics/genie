/**
 * The dispatcher. Where an event becomes a run, or an explained refusal.
 *
 * Everything decidable lives in the pure modules beside this one and is tested
 * there — the registry, the filter, the matcher, the loop guard, admission. This
 * file is the ordering, and the ordering is the design:
 *
 *   attribute → match → loop-admit → resolve body → admission → run
 *
 * Each step can only stop the chain, never widen it, so there is no path from an
 * event to a side effect that skips a gate.
 *
 * ## Nothing here names an event kind
 *
 * That is the property the whole feature rests on, and it is checked
 * structurally by `__tests__/extensible-events.test.ts`: this file is asserted to
 * contain no event id at all. A new kind is a registry entry and a producer that
 * calls {@link WishRuntime.emit}; the dispatcher is not told, because there is
 * nothing to tell it.
 *
 * ## Every outcome is recorded, including the boring ones
 *
 * `emit` returns a log per candidate Wish rather than swallowing the ones that
 * did not run. A Wish silently not firing is the single hardest thing to debug
 * in an automation system — "it just doesn't work" with no thread to pull — so
 * "the filter excluded it", "the loop guard held it", "its body cannot run
 * unattended" are all first-class answers with reasons attached.
 *
 * ## Dependencies are injected
 *
 * Production binds them in `index.ts`. There is no test-only path that could
 * pass while production differs — the same class runs both.
 */

import { decideWishAdmission, describeAdmissionRefusal, type WishStepRefusal } from './admission';
import type { WishEventRegistry } from './events';
import type { WishLoopGuard } from './loop';
import { selectWishesForEvent } from './match';
import { needsWizard, runWishTasks, WishStepError } from './recipe';
import type { Wish, WishEvent, WishRecipe, WishRecipeRef, WishRunContext } from './types';

export type WishRunOutcome =
    /** The body ran to completion. */
    | 'ran'
    /** The body started and a step failed. */
    | 'failed'
    /** Its body cannot run in this mode, or could not be found. */
    | 'refused'
    /** The loop guard held it. */
    | 'blocked'
    /** It needs the renderer's wizard — a manual Wish with UI steps. */
    | 'handoff'
    /** Something about the Wish itself is wrong (an unevaluatable filter). */
    | 'error';

export interface WishRunLog {
    wishId: string;
    runId: string;
    /** The event that selected it; absent on a manual run. */
    event?: string;
    outcome: WishRunOutcome;
    reason?: string;
    refusals?: WishStepRefusal[];
    at: number;
}

export interface WishRuntimeDeps {
    registry: WishEventRegistry;
    guard: WishLoopGuard;
    listWishes: () => readonly Wish[];
    resolveRecipe: (ref: WishRecipeRef) => WishRecipe | null;
    /** Called for every log entry, run or not. Production wires it to the debug log. */
    onLog?: (log: WishRunLog) => void;
    now?: () => number;
    newRunId?: () => string;
}

let runCounter = 0;

export class WishRuntime {
    private readonly deps: WishRuntimeDeps;
    private readonly now: () => number;
    private readonly newRunId: () => string;

    constructor(deps: WishRuntimeDeps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.newRunId = deps.newRunId ?? (() => `wr-${Date.now().toString(36)}-${++runCounter}`);
    }

    /**
     * Deliver an event, run whatever it selects, and report every candidate.
     *
     * Runs are awaited together rather than in sequence: two Wishes watching the
     * same event are independent, and making the second wait on the first would
     * turn one slow body into a queue behind every event. The loop guard's
     * breaker is what bounds the total.
     */
    async emit(raw: WishEvent): Promise<WishRunLog[]> {
        const event = this.deps.guard.attribute({ ...raw, at: raw.at ?? this.now() });
        const { matches, problems } = selectWishesForEvent(
            this.deps.listWishes(),
            event,
            this.deps.registry,
        );

        const logs: WishRunLog[] = problems.map((p) =>
            this.log({
                wishId: p.wishId,
                runId: this.newRunId(),
                event: event.event,
                outcome: 'error',
                reason: p.reason,
            }),
        );

        const runs = await Promise.all(
            matches.map(({ wish }) => this.runForEvent(wish, event)),
        );
        return [...logs, ...runs];
    }

    /**
     * Start a Wish by hand. ATTENDED — a person asked for it, so the body may
     * contain anything the recipe engine can render.
     *
     * A body with UI steps is NOT run here: it is handed back as `handoff` for
     * the renderer's WizardModal, which is the only thing that can render a form
     * or attach a terminal. Reporting `ran` for a body this process never
     * executed would be the runtime lying about the one thing it is for.
     */
    async runManually(wishId: string): Promise<WishRunLog> {
        const wish = this.deps.listWishes().find((w) => w.id === wishId);
        const runId = this.newRunId();
        if (!wish) {
            return this.log({ wishId, runId, outcome: 'refused', reason: 'no such Wish.' });
        }
        if (!wish.enabled) {
            return this.log({ wishId, runId, outcome: 'refused', reason: 'the Wish is disabled.' });
        }
        if (!wish.triggers.some((t) => t.kind === 'manual')) {
            return this.log({
                wishId,
                runId,
                outcome: 'refused',
                reason: 'this Wish has no manual trigger, so it is not startable by hand.',
            });
        }

        const recipe = this.deps.resolveRecipe(wish.recipe);
        if (!recipe) {
            return this.log({
                wishId,
                runId,
                outcome: 'refused',
                reason: `its body "${wish.recipe.recipeId}" is not installed.`,
            });
        }
        if (needsWizard(recipe)) {
            return this.log({
                wishId,
                runId,
                outcome: 'handoff',
                reason: `"${recipe.id}" has steps only the recipe wizard can run.`,
            });
        }
        return this.execute(wish, recipe, undefined, runId);
    }

    /* ----- internals -------------------------------------------------- */

    private async runForEvent(wish: Wish, event: WishEvent): Promise<WishRunLog> {
        const runId = this.newRunId();

        const loop = this.deps.guard.admit(wish.id, event);
        if (!loop.ok) {
            return this.log({
                wishId: wish.id,
                runId,
                event: event.event,
                outcome: 'blocked',
                reason: loop.reason,
            });
        }

        const recipe = this.deps.resolveRecipe(wish.recipe);
        if (!recipe) {
            return this.log({
                wishId: wish.id,
                runId,
                event: event.event,
                outcome: 'refused',
                reason: `its body "${wish.recipe.recipeId}" is not installed.`,
            });
        }

        const admission = decideWishAdmission(recipe, 'unattended');
        if (!admission.ok) {
            return this.log({
                wishId: wish.id,
                runId,
                event: event.event,
                outcome: 'refused',
                reason: describeAdmissionRefusal(recipe, admission.refusals),
                refusals: admission.refusals,
            });
        }

        return this.execute(wish, recipe, event, runId);
    }

    private async execute(
        wish: Wish,
        recipe: WishRecipe,
        event: WishEvent | undefined,
        runId: string,
    ): Promise<WishRunLog> {
        // Only EVENT-driven runs count against the breaker. It exists to catch a
        // loop, and a person pressing a button is not a loop — feeding manual
        // runs into it would let somebody re-running a Wish by hand quietly
        // suppress the system triggers of the same Wish for the next minute.
        if (event) this.deps.guard.noteRun(wish.id);

        const data = new Map<string, unknown>();
        // Recipe args first, event props second: a prop describes THIS
        // occurrence and must win over the Wish's standing configuration.
        for (const [k, v] of Object.entries(wish.recipe.args ?? {})) data.set(k, v);
        if (event) for (const [k, v] of Object.entries(event.props)) data.set(k, v);

        const ctx: WishRunContext = {
            get: (k) => data.get(k),
            set: (k, v) => void data.set(k, v),
            declareEffect: (effect) =>
                this.deps.guard.declareEffect({ ...effect, wishId: wish.id, runId }),
            // The source is stamped HERE, from the run, never taken from what the
            // task passed. A task that could name its own source could name
            // somebody else's — or reset the chain depth and walk straight out of
            // the loop guard. `main/apps/bridge.ts` states the same rule for
            // windows: identity comes from the caller, not from the payload.
            emit: async (announcement) => {
                await this.emit({
                    event: announcement.event,
                    props: announcement.props,
                    source: this.deps.guard.sourceFor(wish.id, runId, event),
                });
            },
            wishId: wish.id,
            runId,
            event,
        };

        try {
            await runWishTasks(recipe, ctx);
            return this.log({
                wishId: wish.id,
                runId,
                event: event?.event,
                outcome: 'ran',
            });
        } catch (e) {
            return this.log({
                wishId: wish.id,
                runId,
                event: event?.event,
                outcome: 'failed',
                reason:
                    e instanceof WishStepError
                        ? e.message
                        : e instanceof Error
                          ? e.message
                          : String(e),
            });
        }
    }

    private log(entry: Omit<WishRunLog, 'at'>): WishRunLog {
        const full: WishRunLog = { ...entry, at: this.now() };
        this.deps.onLog?.(full);
        return full;
    }
}
