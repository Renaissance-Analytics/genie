import type { ForceAnswerSpec, PendingQuestionSpec } from './genie';

/**
 * What a Deck row can actually RESOLVE without opening anything.
 *
 * The temptation is to put buttons on every row. The rule that stops it:
 *
 * **A row may only offer an inline answer when answering inline is the WHOLE answer.**
 *
 * A ForceTheQuestion carries up to four sub-questions, each with its own options and its
 * own free text. Rendering the first one's buttons would submit a partial answer and tell
 * the agent the human had decided — which is worse than making them open the modal,
 * because the agent carries on with three quarters of a decision and nothing says so.
 *
 * The same reasoning rules out a multi-select (one click cannot express "these two of
 * four"), a free-text question (there is no button that answers it), and a forwarded
 * question (it is answered on its own host; resolving the local copy would leave the real
 * one waiting).
 */

export function inlineAnswerable(q: PendingQuestionSpec): boolean {
    // Answered on its own host through the forwarding path.
    if (q.remoteHost) return false;
    // Exactly one part, or an inline answer is partial by construction.
    if (q.questions.length !== 1) return false;
    const only = q.questions[0]!;
    // One click cannot express a multi-select, and submitting a single choice would
    // under-answer it.
    if (only.multiSelect) return false;
    // A free-text question has no button that could answer it; offering one would send an
    // empty note.
    return only.options.length > 0;
}

/**
 * The answer payload for one clicked option, or null when this question must not be
 * answered inline.
 *
 * An option the question does not offer is refused rather than submitted: the row may be
 * stale, and sending an invented option is answering on the human's behalf.
 */
export function answerForOption(q: PendingQuestionSpec, label: string): ForceAnswerSpec[] | null {
    if (!inlineAnswerable(q)) return null;
    const only = q.questions[0]!;
    if (!only.options.some((o) => o.label === label)) return null;
    return [{ header: only.header, question: only.question, selected: [label], note: '' }];
}
