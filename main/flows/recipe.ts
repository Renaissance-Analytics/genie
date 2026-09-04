/**
 * Running an ADMITTED unattended body. Deliberately, almost aggressively small.
 *
 * ## This is not a second step engine
 *
 * `renderer/lib/recipes/engine.ts` is the step engine, and it stays the only
 * one. It owns navigation, forward-gating, per-step lifecycle, capture and error
 * surfacing — everything a person stepping through a wizard needs. A Flow with a
 * manual trigger is handed to it, unchanged, exactly like any other recipe.
 *
 * What is here runs a body that {@link decideFlowAdmission} has already reduced
 * to `task` steps only: no forms to render, no terminal to attach, no browser to
 * hand off to, no back button because nobody is pressing one. That leaves a
 * `for` loop. Reimplementing gating and lifecycle around it would be building a
 * second engine to run the one step type the first engine barely needs.
 *
 * The engine also lives in the RENDERER, and a system-triggered Flow must run
 * when no window is open at all — which is the other reason main cannot simply
 * call it.
 *
 * ## Defence in depth
 *
 * Admission guarantees every step is a task. This loop asserts it anyway. A
 * check that happens once is a check that eventually gets skipped, and the thing
 * it would let through is a shell command with nobody watching.
 */

import type { FlowRecipe, FlowRunContext, FlowTaskStep } from './types';

/** A step failed. Names WHICH one — a bare message from a five-step body is a riddle. */
export class FlowStepError extends Error {
    readonly stepId: string;
    constructor(stepId: string, cause: unknown) {
        super(
            `step "${stepId}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        this.name = 'FlowStepError';
        this.stepId = stepId;
        if (cause instanceof Error) this.cause = cause;
    }
}

function isTaskStep(step: FlowRecipe['steps'][number]): step is FlowTaskStep {
    return (
        (step as { type?: unknown }).type === 'task' &&
        typeof (step as { run?: unknown }).run === 'function'
    );
}

/**
 * Run every step in order, stopping at the first failure.
 *
 * Stopping is the point: a body that carried on past a failed step would leave
 * the machine in a state no step expected, and report neither success nor
 * failure honestly.
 */
export async function runFlowTasks(recipe: FlowRecipe, ctx: FlowRunContext): Promise<void> {
    for (const step of recipe.steps) {
        if (!isTaskStep(step)) {
            throw new Error(
                `Recipe "${recipe.id}" reached the unattended runner with a ` +
                    `"${String((step as { type?: unknown }).type)}" step. Admission should have ` +
                    `refused it; refusing here rather than running it.`,
            );
        }
        try {
            await step.run(ctx);
        } catch (e) {
            throw new FlowStepError(step.id, e);
        }
    }
}

/** True when this body needs the renderer's wizard rather than the loop above. */
export function needsWizard(recipe: FlowRecipe): boolean {
    return recipe.steps.some((s) => !isTaskStep(s));
}
