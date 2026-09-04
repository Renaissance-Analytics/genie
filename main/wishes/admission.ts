/**
 * PURE. May this Wish's body run, given that nobody is watching?
 *
 * ## The hazard
 *
 * A Wish's body is a Recipe, and a Recipe can contain a `terminal` step, which
 * runs a command. A system trigger fires with no human present. Put together
 * without a decision in between, a Wish is a way to run arbitrary commands on a
 * schedule nobody consented to — and the existing gate does not help, because
 * `approveProcessRun` raises a MODAL and blocks until someone answers it. At 3am
 * that is either a command nobody sanctioned or a run wedged forever.
 *
 * ## The decision
 *
 * **An unattended run may execute first-party code and nothing else.**
 *
 * `task` steps are in-repo TypeScript, reviewed when they were written, and a
 * stored Wish can only REFERENCE one by id — a JSON row cannot smuggle a
 * function in. Every other step type is refused when unattended:
 *
 *  - `terminal` runs a shell command with nobody to sanction it;
 *  - `form` and `choice` need a person to answer them, so unattended they would
 *    hang rather than fail — a wedged run that reports nothing is worse than a
 *    refusal that explains itself;
 *  - `browser` opens a window on a machine nobody is sitting at.
 *
 * This is the brief's own fallback taken deliberately: *a Wish that cannot run is
 * far better than one that runs commands nobody sanctioned.* The alternative —
 * a per-Wish "yes, run shells unattended" sanction — is a real thing to build,
 * but it needs a human-approval surface to record consent, and shipping the
 * FIELD before the surface would mean the safe default is one JSON edit away
 * from being off with nobody having agreed to anything.
 *
 * ## Why up front, before any step
 *
 * `main/flows/runner.ts` states this rule for graphs and it is the same rule
 * here: refusing at step 7 after six irreversible side effects is strictly worse
 * than refusing at step 0. So the whole recipe is judged before any of it
 * happens, and one unsafe step refuses all of it.
 *
 * An ATTENDED run admits everything — the person is there, and the existing
 * workspace gates (`workspaceProcessApproval`, `workspaceTerminalApproval`) are
 * the ones that apply, unchanged. Nothing here weakens them.
 */

import type { WishRecipe, WishRecipeStep } from './types';

export type WishRunMode = 'attended' | 'unattended';

export interface WishStepRefusal {
    stepId: string;
    stepType: string;
    reason: string;
}

export interface WishAdmission {
    ok: boolean;
    refusals: WishStepRefusal[];
}

/**
 * The step types an unattended run may execute. Widening this set is the single
 * change in this feature that could let a system trigger run arbitrary commands,
 * so it is asserted by a test rather than merely written down.
 */
export const UNATTENDED_SAFE_STEP_TYPES: ReadonlySet<string> = new Set(['task']);

/**
 * Why each known step type is unsafe unattended. Data, so adding a step type
 * means adding a sentence — and a type with no sentence is refused by the
 * fallback below rather than admitted by omission.
 */
const UNATTENDED_REASONS: Readonly<Record<string, string>> = {
    terminal:
        'it runs a shell command, and with no human present there is nobody to sanction it. ' +
        'Give this Wish a manual trigger and run it yourself, or move the work into a ' +
        'first-party task step.',
    form: 'it asks a person to fill something in, and unattended there is nobody to answer it.',
    choice: 'it asks a person to choose, and unattended there is nobody to choose.',
    browser: 'it opens a browser window on a machine nobody is sitting at.',
};

function refusalFor(step: WishRecipeStep): WishStepRefusal | null {
    const stepType = String((step as { type?: unknown }).type);
    if (UNATTENDED_SAFE_STEP_TYPES.has(stepType)) return null;
    return {
        stepId: String((step as { id?: unknown }).id ?? '(unnamed)'),
        stepType,
        reason:
            UNATTENDED_REASONS[stepType] ??
            `Genie cannot account for a "${stepType}" step with no human present, ` +
                `so it refuses rather than guessing that it is safe.`,
    };
}

/**
 * Judge the whole recipe before any of it runs.
 *
 * `refusals` is every unsafe step, not the first — an author fixing a Wish wants
 * the full list, and reporting one at a time turns a single edit into four
 * rounds.
 */
export function decideWishAdmission(recipe: WishRecipe, mode: WishRunMode): WishAdmission {
    if (mode === 'attended') return { ok: true, refusals: [] };

    const refusals = recipe.steps
        .map(refusalFor)
        .filter((r): r is WishStepRefusal => r !== null);

    return { ok: refusals.length === 0, refusals };
}

/** One line naming what was refused and why — for a log or a notice. */
export function describeAdmissionRefusal(recipe: WishRecipe, refusals: WishStepRefusal[]): string {
    const parts = refusals.map((r) => `"${r.stepId}" (${r.stepType}) — ${r.reason}`);
    return (
        `Recipe "${recipe.id}" cannot run unattended: ${parts.join(' ')} ` +
        `Nothing was run: the whole recipe is refused so it cannot stop half-done.`
    );
}
