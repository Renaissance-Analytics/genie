import type { ForceQuestion } from '../mcp/protocol';

/**
 * Validate what an agent passed to `ForceTheQuestion`, BEFORE it becomes a modal.
 *
 * The owner, twice, with screenshots of both surfaces: a question whose prose
 * rendered perfectly above a column of blank pills, and no way to answer it. The
 * chip was empty, every option was empty, and the only route out was to dismiss
 * it — which at the time also deleted it.
 *
 * The tool's declared schema has always been complete: `header`, `question` and
 * `options` are required, and every option requires a `label`. Nothing enforced
 * it. The handler checked that `questions` was a non-empty array and cast the
 * rest, so any shape at all reached the renderer, which read `o.label` off
 * whatever it was handed and rendered `undefined` as nothing.
 *
 * MCP clients are supposed to validate against the published schema. Several
 * plainly do not, and "the client should have checked" is no answer to a person
 * looking at a modal they cannot use. So the host checks.
 *
 * ## Refuse; do not repair
 *
 * The tempting fix is to coerce — treat `["Yes","No"]` as two labels and carry
 * on. That hides the mistake from the only party who can fix it. The agent gets
 * its call back with the exact path that was wrong and what was received, which
 * it can act on in one turn; the person gets nothing on screen, which is right,
 * because a question nobody can answer is worse than no question at all.
 *
 * ## What is checked, and what deliberately is not
 *
 * SHAPE is enforced: the fields that decide whether a modal is answerable.
 * COUNTS are not. The schema says 1–4 questions and 2–4 options, and those are
 * good guidance — but a question with one option, or five, is still a question a
 * person can answer, and refusing it would break working callers without
 * preventing a single unanswerable modal. Enforcing exactly what is broken is
 * the difference between a fix and a new source of refusals.
 */
export function validateForceQuestions(
    raw: unknown,
): { questions: ForceQuestion[] } | { error: string } {
    if (!Array.isArray(raw) || raw.length === 0) {
        return { error: 'ForceTheQuestion requires a non-empty `questions` array.' };
    }

    for (let i = 0; i < raw.length; i++) {
        const q = raw[i] as Record<string, unknown> | null;
        const at = `questions[${i}]`;
        if (!q || typeof q !== 'object' || Array.isArray(q)) {
            return { error: `${at} must be an object — received ${describe(q)}.` };
        }
        if (!nonEmptyString(q.header)) {
            return {
                error:
                    `${at}.header must be a non-empty string (a very short chip label, ` +
                    `≤ 12 chars) — received ${describe(q.header)}.`,
            };
        }
        if (!nonEmptyString(q.question)) {
            return {
                error:
                    `${at}.question must be a non-empty string (the full question text, ` +
                    `rendered as markdown) — received ${describe(q.question)}.`,
            };
        }
        if (!Array.isArray(q.options) || q.options.length === 0) {
            return {
                error:
                    `${at}.options must be a non-empty array of { label } objects — ` +
                    `received ${describe(q.options)}.`,
            };
        }
        for (let j = 0; j < q.options.length; j++) {
            const o = q.options[j] as Record<string, unknown> | null;
            const oat = `${at}.options[${j}]`;
            if (!o || typeof o !== 'object' || Array.isArray(o)) {
                return {
                    error:
                        `${oat} must be an object with a "label" — received ${describe(o)}. ` +
                        `Options are objects, not bare strings: [{ "label": "Yes" }, ` +
                        `{ "label": "No" }].`,
                };
            }
            if (!nonEmptyString(o.label)) {
                return {
                    error:
                        `${oat}.label must be a non-empty string — received ` +
                        `${describe(o.label)}. Without it the option renders as a blank ` +
                        `button the user cannot identify.`,
                };
            }
            if (o.description !== undefined && typeof o.description !== 'string') {
                return {
                    error: `${oat}.description must be a string when present — received ${describe(o.description)}.`,
                };
            }
        }
        if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') {
            return {
                error: `${at}.multiSelect must be a boolean when present — received ${describe(q.multiSelect)}.`,
            };
        }
    }

    return { questions: raw as ForceQuestion[] };
}

function nonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

/**
 * What arrived, in a form an agent can match against what it sent.
 *
 * The VALUE, not just the type: "received a string" leaves an agent guessing
 * which of its options was wrong, while `received "Yes"` points straight at it.
 * Long values are cut — this goes into an error message, not a log.
 */
function describe(v: unknown): string {
    if (v === undefined) return 'nothing';
    if (v === null) return 'null';
    if (Array.isArray(v)) return `an array of ${v.length}`;
    if (typeof v === 'string') {
        const shown = v.length > 40 ? `${v.slice(0, 40)}…` : v;
        return v.trim().length === 0 ? 'an empty string' : `the string ${JSON.stringify(shown)}`;
    }
    if (typeof v === 'object') return 'an object';
    return `${typeof v} (${String(v)})`;
}
