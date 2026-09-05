/**
 * What the Flow editor works out before anything is stored.
 *
 * Two decisions live here rather than in the component, because both are wrong
 * QUIETLY and neither needs a DOM to be checked:
 *
 *  - **Which fields a body needs.** A recipe declares its inputs; some of them
 *    are supplied by the event that triggers the Flow, and asking a person to
 *    type the path of the file the trigger is about is both impossible and the
 *    surest way to make a form look broken. Which of those are still open
 *    depends on the triggers chosen so far, and changes as they are added.
 *  - **What a typed value MEANS.** `5242880` in a text box is a string, and a
 *    string compared with `gt` against a number prop is a filter the store
 *    refuses. Coercion happens once, here, with the failure reported instead of
 *    stored as `NaN`.
 *
 * Nothing here knows a recipe or an event by name — both arrive as declarations
 * from main, so a second recipe and a second event kind are offered by the same
 * form with no change to it.
 */

import type {
    FlowEventDefinition,
    FlowRecipeInput,
    FlowRecipeSummary,
    FlowTrigger,
} from './genie';

export interface FlowFormField {
    input: FlowRecipeInput;
    /** The Flow cannot be saved without it. */
    required: boolean;
}

/** True when every trigger chosen so far carries this input as a prop. */
function suppliedByEveryTrigger(
    input: FlowRecipeInput,
    triggers: readonly FlowTrigger[],
    events: readonly FlowEventDefinition[],
): boolean {
    if (input.fromEvent !== true || triggers.length === 0) return false;
    return triggers.every((trigger) => {
        if (trigger.kind !== 'event') return false;
        const prop = events
            .find((e) => e.id === trigger.event)
            ?.props.find((p) => p.key === input.key);
        return prop !== undefined && prop.type === input.type;
    });
}

/**
 * The settings this Flow still has to be told, given its triggers.
 *
 * Mirrors the rule `main/flows/authoring.ts` enforces at the write — the store
 * is the gate, this is only which boxes to draw — so a Flow the form let you
 * complete is one the store will accept.
 */
export function flowFormFields(
    recipe: FlowRecipeSummary | null,
    triggers: readonly FlowTrigger[],
    events: readonly FlowEventDefinition[],
): FlowFormField[] {
    if (!recipe) return [];
    return recipe.inputs
        .filter((input) => !suppliedByEveryTrigger(input, triggers, events))
        .map((input) => ({
            input,
            required: input.required === true && input.default === undefined,
        }));
}

export type CoercedValue =
    | { ok: true; value: string | number | boolean | (string | number | boolean)[] }
    | { ok: false; error: string };

function coerceOne(
    raw: string,
    type: 'string' | 'number' | 'boolean',
): { ok: true; value: string | number | boolean } | { ok: false; error: string } {
    const text = raw.trim();
    if (text === '') return { ok: false, error: 'give it a value.' };
    if (type === 'number') {
        // A person typing a file size types 5,242,880. Refusing that would be
        // pedantry about a separator, not a real disagreement about the value.
        const n = Number(text.replace(/,/g, ''));
        if (!Number.isFinite(n)) return { ok: false, error: `“${text}” is not a number.` };
        return { ok: true, value: n };
    }
    if (type === 'boolean') {
        if (text === 'true') return { ok: true, value: true };
        if (text === 'false') return { ok: true, value: false };
        return { ok: false, error: `“${text}” is not true or false.` };
    }
    return { ok: true, value: text };
}

/**
 * One typed box, read as the prop's own type.
 *
 * `listValue` operators (`is one of`) take a comma-separated list. An EMPTY one
 * is refused rather than stored: "the extension is one of nothing" can never
 * match, and a filter that can never match is a Flow that never fires with
 * nothing anywhere looking wrong.
 */
export function coerceFilterValue(
    raw: string,
    type: 'string' | 'number' | 'boolean',
    listValue: boolean,
): CoercedValue {
    if (!listValue) return coerceOne(raw, type);

    const parts = raw
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '');
    if (parts.length === 0) return { ok: false, error: 'list at least one value.' };

    const values: (string | number | boolean)[] = [];
    for (const part of parts) {
        const one = coerceOne(part, type);
        if (!one.ok) return one;
        values.push(one.value);
    }
    return { ok: true, value: values };
}

/**
 * The stored settings the form is NOT showing, so an edit does not drop them.
 *
 * `flowFormFields` hides an input the trigger already supplies. That is right
 * for the box and wrong for the save: a Flow that stored a value for it once
 * would come back without it, changed by an edit nobody made on screen.
 *
 * Only for an edit of the SAME body. When the recipe changes, its old settings
 * belong to a different recipe and are dropped — the store would refuse them
 * anyway, by name.
 */
export function carryHiddenArgs(
    recipe: FlowRecipeSummary | null,
    shown: readonly FlowFormField[],
    stored: Readonly<Record<string, string | number | boolean>> | undefined,
): Record<string, string | number | boolean> {
    if (!recipe || !stored) return {};
    const showing = new Set(shown.map((f) => f.input.key));
    const out: Record<string, string | number | boolean> = {};
    for (const input of recipe.inputs) {
        // A box on screen is authoritative, empty included — that is how a
        // setting is CLEARED.
        if (showing.has(input.key)) continue;
        const value = stored[input.key];
        if (value !== undefined) out[input.key] = value;
    }
    return out;
}
