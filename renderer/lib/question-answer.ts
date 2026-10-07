import type { ForceAnswerSpec, PendingQuestionSpec } from './genie';

/**
 * Answering ANY question from the Deck — not only the one-click kind.
 *
 * ## Why this had to be written before anything could be deleted
 *
 * The Genie 2 plan lists `QuestionInboxFlyout` under P7's deletions as *"chrome only — all
 * logic kept"*. That is wrong, and measurably so: `inlineAnswerable` in `attention-actions.ts`
 * deliberately excludes multi-part, multi-select, free-text and forwarded questions, for
 * reasons that are correct —
 *
 * > *"one click cannot express 'these two of four'… a free-text question has no button that
 * > could answer it; offering one would send an empty note."*
 *
 * So the flyout is not redundant chrome. It is the only surface that answers everything the
 * Deck refuses inline, and deleting it as the plan describes would strand multi-select,
 * multi-part and free-text answers outright. This module is the prerequisite: once the Deck
 * can answer everything, the flyout is genuinely redundant and can go.
 *
 * ## The one thing still refused
 *
 * A FORWARDED question (`remoteHost`) is answered on its own host. Resolving the local copy
 * would mark it done here while the real one waits forever on the machine that asked.
 *
 * ## Why the refusals are the valuable part
 *
 * `buildAnswer` returns `null` rather than a partial. A partial answer is worse than no
 * answer: the agent proceeds on three quarters of a decision and nothing marks it — which is
 * the exact defect `inlineAnswerable` was written to avoid, and the reason it refused so much.
 */

/** What a person has entered for one PART of a question. */
export interface AnswerState {
    selected: string[];
    note: string;
}

/**
 * Whether the Deck can answer this at all.
 *
 * Broader than `inlineAnswerable` on purpose — that one answers "can ONE CLICK finish this",
 * which is a question about a button. This asks "can this surface collect a full answer",
 * which a form can.
 */
export function answerableOnDeck(q: PendingQuestionSpec): boolean {
    // Answered on its own host through the forwarding path.
    if (q.remoteHost) return false;
    // Nothing to answer.
    return q.questions.length > 0;
}

/** One empty slot per part, so a multi-part question cannot answer only half. */
export function blankAnswerState(q: PendingQuestionSpec): AnswerState[] {
    return q.questions.map(() => ({ selected: [], note: '' }));
}

/** Whether one part has been answered. */
function partIsAnswered(
    part: PendingQuestionSpec['questions'][number],
    state: AnswerState | undefined,
): boolean {
    if (!state) return false;
    // A note alone is a complete answer, options or not. The modal always offers free text
    // beside the choices, and an answer that declines every option and explains why is a real
    // answer — frequently the most useful one. It is also the ONLY answer to a question with
    // no options.
    if (state.note.trim().length > 0) return true;
    // One selection is enough for a multi-select: "one of three" is a real answer, and
    // demanding more would invent a requirement the asker did not state.
    return state.selected.length > 0 && state.selected.every((label) =>
        part.options.some((o) => o.label === label),
    );
}

/** Whether EVERY part is answered. Half an answer is the defect, not a stage. */
export function answerIsComplete(q: PendingQuestionSpec, state: readonly AnswerState[]): boolean {
    if (state.length !== q.questions.length) return false;
    return q.questions.every((part, i) => partIsAnswered(part, state[i]));
}

/**
 * Shape a complete answer for the host, or refuse.
 *
 * Null means "do not send this", and every path to it is a case where sending would be worse
 * than waiting: a partial answer, a forwarded question, a selection that is not on offer, or
 * a state built for a different question than the one being answered.
 */
export function buildAnswer(
    q: PendingQuestionSpec,
    state: readonly AnswerState[],
): ForceAnswerSpec[] | null {
    if (!answerableOnDeck(q)) return null;
    if (!answerIsComplete(q, state)) return null;

    return q.questions.map((part, i) => {
        const s = state[i]!;
        return {
            header: part.header,
            question: part.question,
            selected: [...s.selected],
            // Trimmed: trailing whitespace is not content, and a note of spaces is not an
            // answer — `partIsAnswered` already refused that case.
            note: s.note.trim(),
        };
    });
}
