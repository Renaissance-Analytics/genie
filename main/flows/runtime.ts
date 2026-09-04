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
 * calls {@link FlowRuntime.emit}; the dispatcher is not told, because there is
 * nothing to tell it.
 *
 * ## Every outcome is recorded, including the boring ones
 *
 * `emit` returns a log per candidate Flow rather than swallowing the ones that
 * did not run. A Flow silently not firing is the single hardest thing to debug
 * in an automation system — "it just doesn't work" with no thread to pull — so
 * "the filter excluded it", "the loop guard held it", "its body cannot run
 * unattended" are all first-class answers with reasons attached.
 *
 * ## Dependencies are injected
 *
 * Production binds them in `index.ts`. There is no test-only path that could
 * pass while production differs — the same class runs both.
 */

import { decideFlowAdmission, describeAdmissionRefusal, type FlowStepRefusal } from './admission';
import type { FlowEventRegistry } from './events';
import type { FlowLoopGuard } from './loop';
import { selectFlowsForEvent } from './match';
import { needsWizard, runFlowTasks, FlowStepError } from './recipe';
import type { Flow, FlowEvent, FlowRecipe, FlowRecipeRef, FlowRunContext } from './types';

export type FlowRunOutcome =
    /** The body ran to completion. */
    | 'ran'
    /** The body started and a step failed. */
    | 'failed'
    /** Its body cannot run in this mode, or could not be found. */
    | 'refused'
    /** The loop guard held it. */
    | 'blocked'
    /** It needs the renderer's wizard — a manual Flow with UI steps. */
    | 'handoff'
    /** Something about the Flow itself is wrong (an unevaluatable filter). */
    | 'error';

export interface FlowRunLog {
    flowId: string;
    runId: string;
    /** The event that selected it; absent on a manual run. */
    event?: string;
    outcome: FlowRunOutcome;
    reason?: string;
    refusals?: FlowStepRefusal[];
    at: number;
}

export interface FlowRuntimeDeps {
    registry: FlowEventRegistry;
    guard: FlowLoopGuard;
    listFlows: () => readonly Flow[];
    resolveRecipe: (ref: FlowRecipeRef) => FlowRecipe | null;
    /** Called for every log entry, run or not. Production wires it to the debug log. */
    onLog?: (log: FlowRunLog) => void;
    now?: () => number;
    newRunId?: () => string;
}

let runCounter = 0;

export class FlowRuntime {
    private readonly deps: FlowRuntimeDeps;
    private readonly now: () => number;
    private readonly newRunId: () => string;

    constructor(deps: FlowRuntimeDeps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.newRunId = deps.newRunId ?? (() => `wr-${Date.now().toString(36)}-${++runCounter}`);
    }

    /**
     * Deliver an event, run whatever it selects, and report every candidate.
     *
     * Runs are awaited together rather than in sequence: two Flows watching the
     * same event are independent, and making the second wait on the first would
     * turn one slow body into a queue behind every event. The loop guard's
     * breaker is what bounds the total.
     */
    async emit(raw: FlowEvent): Promise<FlowRunLog[]> {
        const event = this.deps.guard.attribute({ ...raw, at: raw.at ?? this.now() });
        const { matches, problems } = selectFlowsForEvent(
            this.deps.listFlows(),
            event,
            this.deps.registry,
        );

        const logs: FlowRunLog[] = problems.map((p) =>
            this.log({
                flowId: p.flowId,
                runId: this.newRunId(),
                event: event.event,
                outcome: 'error',
                reason: p.reason,
            }),
        );

        const runs = await Promise.all(
            matches.map(({ flow }) => this.runForEvent(flow, event)),
        );
        return [...logs, ...runs];
    }

    /**
     * Start a Flow by hand. ATTENDED — a person asked for it, so the body may
     * contain anything the recipe engine can render.
     *
     * A body with UI steps is NOT run here: it is handed back as `handoff` for
     * the renderer's WizardModal, which is the only thing that can render a form
     * or attach a terminal. Reporting `ran` for a body this process never
     * executed would be the runtime lying about the one thing it is for.
     */
    async runManually(flowId: string): Promise<FlowRunLog> {
        const flow = this.deps.listFlows().find((w) => w.id === flowId);
        const runId = this.newRunId();
        if (!flow) {
            return this.log({ flowId, runId, outcome: 'refused', reason: 'no such Flow.' });
        }
        if (!flow.enabled) {
            return this.log({ flowId, runId, outcome: 'refused', reason: 'the Flow is disabled.' });
        }
        if (!flow.triggers.some((t) => t.kind === 'manual')) {
            return this.log({
                flowId,
                runId,
                outcome: 'refused',
                reason: 'this Flow has no manual trigger, so it is not startable by hand.',
            });
        }

        const recipe = this.deps.resolveRecipe(flow.recipe);
        if (!recipe) {
            return this.log({
                flowId,
                runId,
                outcome: 'refused',
                reason: `its body "${flow.recipe.recipeId}" is not installed.`,
            });
        }
        if (needsWizard(recipe)) {
            return this.log({
                flowId,
                runId,
                outcome: 'handoff',
                reason: `"${recipe.id}" has steps only the recipe wizard can run.`,
            });
        }
        return this.execute(flow, recipe, undefined, runId);
    }

    /* ----- internals -------------------------------------------------- */

    private async runForEvent(flow: Flow, event: FlowEvent): Promise<FlowRunLog> {
        const runId = this.newRunId();

        const loop = this.deps.guard.admit(flow.id, event);
        if (!loop.ok) {
            return this.log({
                flowId: flow.id,
                runId,
                event: event.event,
                outcome: 'blocked',
                reason: loop.reason,
            });
        }

        const recipe = this.deps.resolveRecipe(flow.recipe);
        if (!recipe) {
            return this.log({
                flowId: flow.id,
                runId,
                event: event.event,
                outcome: 'refused',
                reason: `its body "${flow.recipe.recipeId}" is not installed.`,
            });
        }

        const admission = decideFlowAdmission(recipe, 'unattended');
        if (!admission.ok) {
            return this.log({
                flowId: flow.id,
                runId,
                event: event.event,
                outcome: 'refused',
                reason: describeAdmissionRefusal(recipe, admission.refusals),
                refusals: admission.refusals,
            });
        }

        return this.execute(flow, recipe, event, runId);
    }

    private async execute(
        flow: Flow,
        recipe: FlowRecipe,
        event: FlowEvent | undefined,
        runId: string,
    ): Promise<FlowRunLog> {
        // Only EVENT-driven runs count against the breaker. It exists to catch a
        // loop, and a person pressing a button is not a loop — feeding manual
        // runs into it would let somebody re-running a Flow by hand quietly
        // suppress the system triggers of the same Flow for the next minute.
        if (event) this.deps.guard.noteRun(flow.id);

        const data = new Map<string, unknown>();
        // Recipe args first, event props second: a prop describes THIS
        // occurrence and must win over the Flow's standing configuration.
        for (const [k, v] of Object.entries(flow.recipe.args ?? {})) data.set(k, v);
        if (event) for (const [k, v] of Object.entries(event.props)) data.set(k, v);

        const ctx: FlowRunContext = {
            get: (k) => data.get(k),
            set: (k, v) => void data.set(k, v),
            declareEffect: (effect) =>
                this.deps.guard.declareEffect({ ...effect, flowId: flow.id, runId }),
            // The source is stamped HERE, from the run, never taken from what the
            // task passed. A task that could name its own source could name
            // somebody else's — or reset the chain depth and walk straight out of
            // the loop guard. `main/apps/bridge.ts` states the same rule for
            // windows: identity comes from the caller, not from the payload.
            emit: async (announcement) => {
                await this.emit({
                    event: announcement.event,
                    props: announcement.props,
                    source: this.deps.guard.sourceFor(flow.id, runId, event),
                });
            },
            flowId: flow.id,
            runId,
            event,
        };

        try {
            await runFlowTasks(recipe, ctx);
            return this.log({
                flowId: flow.id,
                runId,
                event: event?.event,
                outcome: 'ran',
            });
        } catch (e) {
            return this.log({
                flowId: flow.id,
                runId,
                event: event?.event,
                outcome: 'failed',
                reason:
                    e instanceof FlowStepError
                        ? e.message
                        : e instanceof Error
                          ? e.message
                          : String(e),
            });
        }
    }

    private log(entry: Omit<FlowRunLog, 'at'>): FlowRunLog {
        const full: FlowRunLog = { ...entry, at: this.now() };
        this.deps.onLog?.(full);
        return full;
    }
}
