import type { StreamEvent } from './stream-event.js';

/**
 * WHAT THE INSPECTOR SHOWS FOR A TOOL CALL — and what it refuses to show.
 *
 * Selecting an edit row opens its diff on the right. The diff has to come from somewhere, and
 * the only source is the arguments the agent reported. That makes this a module about the
 * difference between data and inference.
 *
 * ## The case that shaped it: `Write`
 *
 * `Write` reports only the content it wrote. There is no `before`. Supplying `before: ''`
 * renders every line as newly added — **exactly right for a new file and a confident lie about
 * an overwrite** — and nothing on the wire distinguishes the two. So a `Write` gets a content
 * view that says what it is showing, rather than a diff that would be wrong half the time.
 *
 * ## `rawInput === null` is not `{}`
 *
 * `null` says the agent did not send this call's arguments. `{}` says it sent an empty object,
 * which some tools genuinely do. The first is a refusal with a reason; the second is data and
 * renders as data.
 */

/**
 * JSON, as a type the renderer can hand straight to `JsonEditor`.
 *
 * Declared here rather than imported so `src/core` stays free of anything that pulls in React;
 * it is structurally the same shape and the assignment is checked at the component boundary.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type InspectorContent =
    | { kind: 'diff'; path: string | null; before: string; after: string }
    /** The full new content, because no prior version was reported. `note` says so on screen. */
    | { kind: 'content'; path: string | null; text: string; note: string }
    | { kind: 'json'; value: JsonValue }
    | { kind: 'text'; text: string }
    /** Nothing to show, with the reason — never an empty panel. */
    | { kind: 'none'; reason: string };

/**
 * Narrow an unknown argument blob to JSON, or `null`.
 *
 * `rawInput` arrives from a `JSON.parse` of the provider's stdout, so in practice it IS JSON —
 * but "in practice" is not a type, and the failure if it is ever wrong is not a cosmetic one:
 * a cyclic object or a `BigInt` makes the JSON view throw, which takes the Agent view down
 * with it while someone is reading a turn.
 *
 * So it is checked, with a `seen` set for cycles, and anything that fails falls through to the
 * text view — which can render anything and claims nothing.
 */
function asJson(value: unknown, seen: Set<object> = new Set()): JsonValue | null {
    if (value === null) return null;

    switch (typeof value) {
        case 'string':
        case 'boolean':
            return value;
        case 'number':
            // `NaN` and `Infinity` are not JSON, and `JSON.stringify` turns them into `null` —
            // silently converting a broken number into a legitimate-looking one.
            return Number.isFinite(value) ? value : null;
        case 'object':
            break;
        default:
            return null;
    }

    const object = value as object;
    if (seen.has(object)) return null;
    seen.add(object);

    try {
        if (Array.isArray(object)) {
            const out: JsonValue[] = [];
            for (const item of object) {
                const narrowed = asJson(item, seen);
                if (narrowed === null && item !== null) return null;
                out.push(narrowed);
            }
            return out;
        }

        const out: Record<string, JsonValue> = {};
        for (const [key, item] of Object.entries(object)) {
            const narrowed = asJson(item, seen);
            if (narrowed === null && item !== null) return null;
            out[key] = narrowed;
        }
        return out;
    } finally {
        seen.delete(object);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' ? value : null;
}

/** `{ old_string, new_string }` pairs, from an `Edit` or every entry of a `MultiEdit`. */
function editPairs(input: Record<string, unknown>): readonly { before: string; after: string }[] {
    const edits = input['edits'];
    if (Array.isArray(edits)) {
        // A malformed entry is skipped rather than contributing `undefined` to either side.
        return edits.flatMap((e) => {
            if (!isRecord(e)) return [];
            const before = stringAt(e, 'old_string');
            const after = stringAt(e, 'new_string');
            return before === null && after === null ? [] : [{ before: before ?? '', after: after ?? '' }];
        });
    }

    const before = stringAt(input, 'old_string');
    const after = stringAt(input, 'new_string');
    return before === null && after === null ? [] : [{ before: before ?? '', after: after ?? '' }];
}

export function inspectorFor(event: Extract<StreamEvent, { kind: 'tool' }>): InspectorContent {
    const input = event.rawInput;

    if (input === null || input === undefined) {
        return { kind: 'none', reason: 'The agent did not report this call’s arguments.' };
    }

    if (typeof input === 'string') return { kind: 'text', text: input };

    if (!isRecord(input)) {
        const json = asJson(input);
        return json === null
            ? { kind: 'text', text: String(input) }
            : { kind: 'json', value: json };
    }

    const path = stringAt(input, 'file_path');

    if (event.toolKind === 'edit') {
        const pairs = editPairs(input);

        if (pairs.length > 0) {
            // Concatenated, because one tool call is one thing the agent did and one view
            // should cover it.
            const before = pairs.map((p) => p.before).join('\n');
            const after = pairs.map((p) => p.after).join('\n');

            // An identical-sides diff renders an empty panel, which reads as a broken
            // inspector rather than as "nothing changed". Fall through to the content view.
            if (before !== after) return { kind: 'diff', path, before, after };
        }

        const content = stringAt(input, 'content');
        if (content !== null) {
            return {
                kind: 'content',
                path,
                text: content,
                // Said on screen, not just reasoned about here.
                note: 'Showing the written content — the prior contents were not reported, so Genie cannot show a diff.',
            };
        }

        return { kind: 'none', reason: 'This edit reported no before-and-after to compare.' };
    }

    const json = asJson(input);
    if (json !== null) return { kind: 'json', value: json };

    // Not representable as JSON. The text view renders anything and claims nothing, which is
    // better than a JSON view that throws and takes the Agent view down mid-turn.
    return { kind: 'text', text: String(input) };
}
