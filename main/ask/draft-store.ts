/**
 * Part-typed answers to ForceTheQuestion requests, held in MAIN so they outlive
 * the surface that is collecting them.
 *
 * `renderer/lib/ask-state.ts` already states the rule — "a draft belongs to the
 * QUESTION, not to the modal" — but until this existed it only held while a
 * component stayed mounted, and neither surface does:
 *
 *  - the FTQ window is a separate BrowserWindow that main CLOSES when the queue
 *    drains (`force-question.ts`), destroying its renderer state outright;
 *  - the in-app question flyout returns `null` when shut, so its per-question
 *    selections and note unmount with it.
 *
 * Someone who ticks two options, starts typing, and steps away to check
 * something came back to a blank form. Main is the only place both surfaces can
 * share, and the only one that survives a window being destroyed — so the draft
 * lives here and each surface is a view onto it.
 *
 * PURE: no electron, no db. The caller owns persistence and IPC.
 */

/** A part-typed answer to one request: option labels + a note, per question index. */
export interface AskDraftEntry {
    selected: Record<number, string[]>;
    notes: Record<number, string>;
}

/** Every in-progress answer, keyed by pending-request id. */
export type AskDraftStore = Record<string, AskDraftEntry>;

/**
 * Record the draft for one question.
 *
 * REPLACES rather than merges. Un-ticking an option has to be able to remove it,
 * and a merge would make selection one-way — every box ticked once would stay
 * ticked forever.
 */
export function putDraft(
    store: AskDraftStore,
    questionId: string,
    entry: AskDraftEntry,
): AskDraftStore {
    return { ...store, [questionId]: entry };
}

/** Forget one question's draft — it was answered or cancelled. */
export function dropDraft(store: AskDraftStore, questionId: string): AskDraftStore {
    if (!(questionId in store)) return store;
    const next = { ...store };
    delete next[questionId];
    return next;
}

/**
 * Keep only the drafts whose questions are still pending.
 *
 * Questions get retracted, answered on the phone, or resolved by the host first,
 * and none of those routes come back through this store. Without a prune it
 * grows without bound, and a recycled id would hand someone a stranger's
 * half-written answer.
 */
export function pruneDrafts(
    store: AskDraftStore,
    pendingIds: readonly string[],
): AskDraftStore {
    const keep = new Set(pendingIds);
    const next: AskDraftStore = {};
    for (const [id, entry] of Object.entries(store)) {
        if (keep.has(id)) next[id] = entry;
    }
    return next;
}

export function serializeDraftStore(store: AskDraftStore): string {
    return JSON.stringify(store);
}

/**
 * Read the store back, treating anything unreadable as "no drafts".
 *
 * This is read on the path that SHOWS a question. A parse error must never be
 * able to stop the modal appearing: losing a draft is bad, losing the question
 * is worse. Entries that are not shaped like a draft are dropped individually,
 * so one bad row cannot take the rest with it.
 */
export function parseDraftStore(raw: string | null | undefined): AskDraftStore {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: AskDraftStore = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const entry = value as Partial<AskDraftEntry>;
        const selected = entry.selected;
        const notes = entry.notes;
        if (!selected || typeof selected !== 'object') continue;
        if (!notes || typeof notes !== 'object') continue;
        out[id] = {
            selected: selected as Record<number, string[]>,
            notes: notes as Record<number, string>,
        };
    }
    return out;
}
