/**
 * ForceTheQuestion modal state — which pending request is being answered, and
 * the answer the user is part-way through typing (genie#156).
 *
 * Genie is multi-agent: while the user reads and answers ONE question, other
 * agents keep raising their own, the head can advance because the question was
 * answered on the phone, and a forwarded host question can be retracted. None of
 * that is allowed to disturb the person mid-answer, so two rules are encoded here
 * rather than left implicit in the component:
 *
 *  - **The user owns their pin.** Once they've picked which queued request to
 *    answer, they stay on it until that request is actually gone. Queue churn
 *    never swaps the question out from under them.
 *  - **A draft belongs to the QUESTION, not to the modal.** Answers are keyed by
 *    request id, so nothing that happens to the queue can wipe what was typed, and
 *    switching away and back finds it intact.
 *
 * PURE + framework-free: the renderer has no jsdom harness, so the judgement is
 * unit-tested here and `ask.tsx` is a thin shell over it.
 */

/** A part-typed answer to one request: option labels + a note, per question index. */
export interface AskDraft {
    selected: Record<number, string[]>;
    notes: Record<number, string>;
}

/** Every in-progress answer, keyed by pending-request id. */
export type AskDrafts = Record<string, AskDraft>;

const EMPTY: AskDraft = { selected: {}, notes: {} };

/** The draft for one request — an empty one when it hasn't been touched yet. */
export function draftFor(drafts: AskDrafts, id: string): AskDraft {
    return drafts[id] ?? EMPTY;
}

/**
 * Which pending request the modal should show.
 *
 * A pin the user made wins for as long as that request is still pending — that is
 * the whole point: an arriving question must not yank them off it. When the pinned
 * request is gone (they answered it, or it was retracted) we fall back to main's
 * head, and to the first pending request when no head has arrived yet.
 */
export function resolveActiveQuestionId(input: {
    /** The request the user explicitly picked from the queue strip, if any. */
    pinnedId: string | null;
    /** Main's current head — the request it last pushed on `ask:show`. */
    headId: string | null;
    /** Ids still pending, from the last `ask:queue` push. */
    pendingIds: readonly string[];
}): string | null {
    const { pinnedId, headId, pendingIds } = input;
    if (pinnedId && pendingIds.includes(pinnedId)) return pinnedId;
    // `ask:show` and `ask:queue` arrive on separate channels, so trust the head
    // even before the first queue push lands.
    if (headId) return headId;
    return pendingIds[0] ?? null;
}

/** Toggle one option in a request's draft. Returns a NEW drafts map. */
export function toggleDraftOption(
    drafts: AskDrafts,
    id: string,
    questionIndex: number,
    label: string,
    multiSelect: boolean,
): AskDrafts {
    const draft = draftFor(drafts, id);
    const current = draft.selected[questionIndex] ?? [];
    const next = multiSelect
        ? current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label]
        : // Single-select: picking the chosen option again clears it.
          current[0] === label
          ? []
          : [label];
    return {
        ...drafts,
        [id]: { ...draft, selected: { ...draft.selected, [questionIndex]: next } },
    };
}

/** Set the free-text note for one question. Returns a NEW drafts map. */
export function setDraftNote(
    drafts: AskDrafts,
    id: string,
    questionIndex: number,
    note: string,
): AskDrafts {
    const draft = draftFor(drafts, id);
    return {
        ...drafts,
        [id]: { ...draft, notes: { ...draft.notes, [questionIndex]: note } },
    };
}

/** Drop one request's draft (it was answered or cancelled). Returns a NEW map. */
export function clearDraft(drafts: AskDrafts, id: string): AskDrafts {
    if (!(id in drafts)) return drafts;
    const next = { ...drafts };
    delete next[id];
    return next;
}

/** Submittable? Every question needs an option or a non-blank note. */
export function isDraftReady(draft: AskDraft, questionCount: number): boolean {
    if (questionCount <= 0) return false;
    for (let qi = 0; qi < questionCount; qi++) {
        const picked = (draft.selected[qi] ?? []).length > 0;
        const noted = (draft.notes[qi] ?? '').trim() !== '';
        if (!picked && !noted) return false;
    }
    return true;
}

/** The minimum a question needs to look like for {@link draftToAnswers}. */
interface AnswerableQuestion {
    header: string;
    question: string;
}

/** Turn a draft into the answer payload main expects, question by question. */
export function draftToAnswers<Q extends AnswerableQuestion>(
    draft: AskDraft,
    questions: readonly Q[],
): Array<{ header: string; question: string; selected: string[]; note: string }> {
    return questions.map((q, qi) => ({
        header: q.header,
        question: q.question,
        selected: draft.selected[qi] ?? [],
        note: (draft.notes[qi] ?? '').trim(),
    }));
}
