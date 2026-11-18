import type { DeckItem } from './deck.js';

/**
 * WHAT AN ANSWER CARRIES (Tynn #861; the owner on his phone, over Tailscale: Allow on "Genie wants to sign a
 * Proof-of-Done…" said "this is too large to send to another device").
 *
 * An answer names the item it answers and says the answer: the item's id, the option (or a question form's picks and
 * notes), the person's note, and for a question the revision it was answered on (Tynn #600 refuses an answer to an older
 * copy). Nothing else of the item crosses. The host answers from its OWN pending record (main/deck-answer.ts): the title
 * the note quotes, the agent the note reaches, the options an answer must be one of. A client's copy of the item could
 * be stale, large or forged; none of that may decide what was approved.
 */
export type DeckItemRef = Pick<DeckItem, 'id'> & { readonly revision?: number | undefined };

/** The longest note an answer may carry, in characters. Over it the answer is refused in words, never cut. */
export const DECK_NOTE_MAX_CHARS = 4_000;

/** Why these notes cannot be sent, or `null` when every one is within the cap (anything that is not a string is no note). */
export function deckNoteRefusal(notes: readonly unknown[]): string | null {
    return notes.some((n) => typeof n === 'string' && n.length > DECK_NOTE_MAX_CHARS)
        ? `A note can be at most ${DECK_NOTE_MAX_CHARS.toLocaleString('en-US')} characters; shorten it and answer again. Nothing was sent.`
        : null;
}

/** The notes an answer action carries: its note, and a form's note per question. */
export function deckAnswerNotes(action: { readonly note?: unknown; readonly notes?: unknown }): unknown[] {
    return [action.note, ...(Array.isArray(action.notes) ? action.notes : [])];
}

/** The item as an answer names it: its id, and its revision when it has one. */
export function deckItemRef(item: { readonly id: string; readonly revision?: number | undefined }): DeckItemRef {
    return typeof item.revision === 'number' ? { id: item.id, revision: item.revision } : { id: item.id };
}

type AnyAction = { readonly kind: string };

/**
 * An action as a client sends it: a Deck answer reduced to `{ kind, item: { id[, revision] }, optionId | selections +
 * notes, note }`, refused (thrown, in words) when a note is over the cap. Every other action passes through untouched.
 */
export function deckActionForWire<A extends AnyAction>(action: A): A {
    if (action.kind !== 'deck.answer' && action.kind !== 'deck.answerForm') return action;
    const a = action as unknown as { item: { id: string; revision?: number }; optionId?: string; note?: string; selections?: string[][]; notes?: string[] };
    const refusal = deckNoteRefusal(deckAnswerNotes(a));
    if (refusal) throw new Error(refusal);
    if (action.kind === 'deck.answer') {
        return { kind: 'deck.answer', item: deckItemRef(a.item), optionId: a.optionId, ...(typeof a.note === 'string' && a.note !== '' ? { note: a.note } : {}) } as unknown as A;
    }
    return { kind: 'deck.answerForm', item: deckItemRef(a.item), selections: a.selections, notes: a.notes, note: a.note ?? '' } as unknown as A;
}
