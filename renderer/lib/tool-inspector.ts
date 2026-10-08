import type { ToolCall } from '../../main/agentsession/model';

/**
 * THE INSPECTOR — §5.2's *"every tool call with its arguments and result"*.
 *
 * Both halves were being discarded until genie#843: `rawInput` was read only to sniff for plan
 * tools, and the result was never read at all.
 *
 * ## The diff view is supported and UNPROVEN, and that matters
 *
 * The board draws a selected edit opening as a diff. Measured, a real `tool_call_update` for a
 * `Write` carries a doubly-nested TEXT confirmation:
 *
 *     content: [{ type: 'content', content: { type: 'text', text: 'File created successfully…' } }]
 *
 * ACP *defines* a `diff` variant with `path`/`oldText`/`newText`, and this reads it when it
 * arrives — but claude sent one in none of the captured turns. Supporting it costs a branch and
 * makes the surface correct the day a provider does send one, with no component change. Saying
 * so here is the point: the alternative is someone later wondering why the diff never appears,
 * or worse, a surface that fabricates one.
 *
 * ## Everything here must survive junk
 *
 * `rawInput` and `result` are an agent's payloads — `unknown` in the model for that reason.
 * This runs inside a render, so a throw takes the whole stream with it. Every branch degrades
 * instead.
 */

export interface ToolDiff {
    path: string;
    oldText: string;
    newText: string;
}

export interface ToolInspector {
    /** The arguments, formatted to be read. `null` ⇒ the agent reported none. */
    args: string | null;
    /** The result, flattened to text. `null` ⇒ nothing reported — which for a pending call is
     *  the truth, and is why this is not an empty string. */
    result: string | null;
    /** A structured diff, when the provider sent one. See the note above. */
    diff: ToolDiff | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text out of one content entry, in either nesting the protocol permits. */
function textOfEntry(entry: unknown): string | null {
    if (!isRecord(entry)) return null;
    // The DOUBLY-nested shape a real agent sends: `{type:'content', content:{type:'text'}}`.
    const inner = entry['content'];
    if (isRecord(inner) && inner['type'] === 'text' && typeof inner['text'] === 'string') {
        return inner['text'];
    }
    // And the flat one, which is also valid ACP. Supporting both costs a branch; supporting
    // one and guessing costs an empty pane for every call.
    if (entry['type'] === 'text' && typeof entry['text'] === 'string') return entry['text'];
    return null;
}

function diffOfEntry(entry: unknown): ToolDiff | null {
    if (!isRecord(entry) || entry['type'] !== 'diff') return null;
    const { path, oldText, newText } = entry as Record<string, unknown>;
    // ALL THREE or nothing. A one-sided diff is not a diff, and a pane rendering half of one
    // would claim nothing changed on the missing side.
    if (typeof path !== 'string' || typeof oldText !== 'string' || typeof newText !== 'string') {
        return null;
    }
    return { path, oldText, newText };
}

export function inspectorFor(call: ToolCall): ToolInspector {
    let args: string | null = null;
    if (call.rawInput !== null && call.rawInput !== undefined) {
        try {
            // Indented: a one-line JSON blob holding a forty-line file write is not oversight,
            // it is the same opacity in a different font.
            args = JSON.stringify(call.rawInput, null, 2);
        } catch {
            // A cyclic payload makes `stringify` throw, and inside a render that is the whole
            // surface. A note is strictly better than a blank pane, which would read as "no
            // arguments" — the opposite of the truth.
            args = '(arguments could not be shown — the agent sent a value that cannot be serialised)';
        }
        if (args === undefined) args = null;
    }

    const entries = Array.isArray(call.result) ? call.result : [];
    const texts = entries.map(textOfEntry).filter((t): t is string => t !== null);
    const diff = entries.map(diffOfEntry).find((d): d is ToolDiff => d !== null) ?? null;

    return {
        args,
        result: texts.length > 0 ? texts.join('\n') : null,
        diff,
    };
}
