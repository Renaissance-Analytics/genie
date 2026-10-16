/**
 * A PART-WRITTEN ANSWER BELONGS TO ITS QUESTION, NOT TO THE WINDOW (the owner, 2026-10-15: "no data should be lost in the
 * forms a user is filling out if another agent sends an ftq request while they are filling it out"). Genie 1's rule,
 * carried over (genie renderer/lib/ask-state.ts, main/ask/draft-store.ts):
 *
 * - **A draft is keyed by question id.** Whatever happens to the queue — another agent asks, one is answered in the
 *   Deck, the person looks at another question and comes back — the options picked and the notes written stay with
 *   the question they were written for.
 * - **The person owns their pick.** The question they chose to answer stays in front of them until it is gone; an
 *   arrival is listed, never swapped in.
 * - **A pushed view never overwrites what the person is typing.** Main also keeps every draft (so a closed window
 *   loses nothing), but the window's own copy is what they are typing into: main's copy only fills a question the
 *   window has no draft for.
 *
 * PURE: no React, no Electron. The question window (renderer/question-main.tsx) is a thin shell over it.
 */
export interface QuestionDraft {
    /** Chosen labels, one array per question. */
    readonly selections: readonly (readonly string[])[];
    /** One note per question ('' where none). */
    readonly notes: readonly string[];
    /** The question's revision it was written for (its agent may update it; an updated question starts a clean draft). */
    readonly revision?: number;
}

export type QuestionDrafts = Readonly<Record<string, QuestionDraft>>;

/** Record one question's draft. REPLACES (un-ticking an option must be able to remove it). */
export function putDraft(drafts: QuestionDrafts, id: string, draft: QuestionDraft): QuestionDrafts {
    return { ...drafts, [id]: draft };
}

/** Forget one question's draft — it was answered, dismissed or withdrawn. */
export function dropDraft(drafts: QuestionDrafts, id: string): QuestionDrafts {
    if (!(id in drafts)) return drafts;
    const next = { ...drafts };
    delete next[id];
    return next;
}

/** Keep only the drafts of questions that are still asked (a recycled id must never hand over a stranger's answer). */
export function pruneDrafts(drafts: QuestionDrafts, stillAsked: readonly string[]): QuestionDrafts {
    const keep = new Set(stillAsked);
    const ids = Object.keys(drafts);
    if (ids.every((id) => keep.has(id))) return drafts;
    return Object.fromEntries(ids.filter((id) => keep.has(id)).map((id) => [id, drafts[id]!]));
}

/**
 * A view pushed by main, merged into what the window holds: the window's own drafts win (they are what the person is
 * typing), main's fill only the questions the window has none for, and a question no longer in the queue drops its
 * draft.
 */
export function mergeDrafts(local: QuestionDrafts, fromMain: QuestionDrafts, queue: readonly string[]): QuestionDrafts {
    const merged: Record<string, QuestionDraft> = {};
    for (const id of queue) {
        const draft = local[id] ?? fromMain[id];
        if (draft) merged[id] = draft;
    }
    return merged;
}

/**
 * Which question the window shows: the person's pick while it is still asked; otherwise main's choice; otherwise the
 * first in the queue. A question arriving never moves it.
 */
export function activeQuestion(input: { picked: string | null; shown: string | null; queue: readonly string[] }): string | null {
    const { picked, shown, queue } = input;
    if (picked !== null && queue.includes(picked)) return picked;
    if (shown !== null && queue.includes(shown)) return shown;
    return queue[0] ?? null;
}
