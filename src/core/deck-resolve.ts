import type { DeckItem } from './deck.js';
import { TRUST_DECK_ID } from './gen-ca.js';

/**
 * RESOLVING A DECK ITEM IN PLACE (§4.5) — what pressing an option on each kind MEANS, as a plain
 * command the main process executes. Pure: every branch is here, and the dispatcher in main is a
 * switch with no judgement in it. An answer that makes no sense for its source is refused, never
 * guessed into the nearest thing — a Deck that "helpfully" marked a question done because the user
 * pressed the only button is a Deck that lost a decision.
 *
 * The item id's prefix is the item's ORIGIN, decided by whoever minted it: `q_` the attention
 * store's questions, `appr_` the approval queue, `approval:<agent>` a provider's permission request
 * (the session layer), `li_` list items, `msg_` mail, `fin_` finishes, `genie:` Genie's own asks.
 */

export type DeckCommand =
    | { kind: 'answer-question'; questionId: string; selections: string[][]; notes: string[]; note: string }
    | { kind: 'resolve-approval'; approvalId: string; choice: 'allow' | 'deny' }
    | { kind: 'answer-provider-approval'; agentId: string; optionId: string }
    | { kind: 'list-done'; workspaceId: string; itemId: string }
    | { kind: 'mark-read'; messageId: string }
    | { kind: 'mark-seen'; finishedId: string }
    | { kind: 'restart-with-handoff'; agentId: string; finishedId: string }
    | { kind: 'navigate'; route: string }
    | { kind: 'trust-certificate' }
    | { kind: 'defer-trust-certificate' }
    | { kind: 'refused'; reason: string };

const refuse = (reason: string): DeckCommand => ({ kind: 'refused', reason });

/**
 * HOW MANY QUESTIONS STILL NEED AN ANSWER — Genie 1's rule (genie renderer/lib/ask-state.ts `isDraftReady`), carried over
 * because the owner asked for it back (2026-10-14: "I should have a note section for every question asked"): a question is
 * answered by at least one option OR a non-blank note of its own. One rule, used by the form (its Answer button and the
 * count beside it) and by `resolveDeckForm` (the refusal), so the two can never disagree about what "ready" means.
 */
export function unansweredCount(questionCount: number, selections: readonly (readonly string[])[], notes: readonly string[]): number {
    let missing = 0;
    for (let i = 0; i < questionCount; i++) {
        const picked = (selections[i] ?? []).length > 0;
        const noted = (notes[i] ?? '').trim() !== '';
        if (!picked && !noted) missing++;
    }
    return missing;
}

/**
 * THE FORM, filled in place (§4.5): one array of chosen labels per question, in order, and one note per question (the
 * form offers a note under every question, as Genie 1's did). Checked here, not guessed: a question is answered by at
 * least one of its options OR a non-blank note; a single-select takes at most one label; every label must be one of that
 * question's options; a forwarded question is never answered here. `note` is the overall note a caller other than the
 * form may still send (the form itself no longer shows one).
 */
export function resolveDeckForm(item: DeckItem, selections: readonly (readonly string[])[], notes: readonly string[], note = ''): DeckCommand {
    if (item.forwardedFrom !== null || item.answer.kind === 'elsewhere') {
        const host = item.answer.kind === 'elsewhere' ? item.answer.host : item.forwardedFrom;
        return refuse(`this question was raised on ${host} and must be answered there`);
    }
    if (item.answer.kind !== 'form') return refuse('this item is not a form; answer it with one of its options');
    if (!item.id.startsWith('q_')) return refuse(`${item.id} is not a question Genie knows how to answer`);
    const questions = item.answer.questions;
    if (!questions) return refuse('this item did not carry its questions; open the agent to answer it');
    if (selections.length !== questions.length) return refuse(`${questions.length} questions, ${selections.length} answers`);
    if (notes.length > questions.length) return refuse(`${questions.length} questions, ${notes.length} notes`);
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i]!;
        const picked = selections[i] ?? [];
        const labels = q.options.map((o) => o.label);
        const stray = picked.find((p) => !labels.includes(p));
        if (stray !== undefined) return refuse(`"${stray}" is not one of the options for ${q.header}`);
        if (q.multiSelect !== true && picked.length > 1) return refuse(`${q.header} takes one answer`);
        if (unansweredCount(1, [picked], [notes[i] ?? '']) > 0) return refuse(`${q.header} needs an option or a note`);
    }
    return {
        kind: 'answer-question',
        questionId: item.id,
        selections: selections.map((s) => [...s]),
        notes: questions.map((_, i) => (notes[i] ?? '').trim()),
        note,
    };
}

/**
 * Which channel an answer travels: a PROVIDER approval (`approval:<agent>`) goes back through the
 * session layer with the provider's own option id; everything else is a feature action the main
 * process resolves against the stores. Decided here so the renderer has no judgement in it.
 */
export function deckAnswerChannel(item: DeckItem): { kind: 'provider'; agentId: string } | { kind: 'feature' } | { kind: 'refused'; reason: string } {
    if (!item.id.startsWith('approval:')) return { kind: 'feature' };
    if (!item.agentId) return { kind: 'refused', reason: 'this approval names no agent' };
    return { kind: 'provider', agentId: item.agentId };
}

export type DeckAnswerRoute =
    | { kind: 'provider'; agentId: string; optionId: string }
    | { kind: 'feature' }
    | { kind: 'navigate'; route: string }
    | { kind: 'restart-with-handoff'; agentId: string; finishedId: string }
    | { kind: 'refused'; reason: string };

/**
 * WHERE an answer goes — the renderer's one decision: a provider approval back through the session
 * layer; Open is a navigation the window does itself; Restart-with-this is a session command with
 * its own bridge call; everything else is a feature action main resolves against the stores.
 */
export function deckAnswerRoute(item: DeckItem, optionId: string): DeckAnswerRoute {
    const channel = deckAnswerChannel(item);
    if (channel.kind === 'refused') return channel;
    if (channel.kind === 'provider') return { kind: 'provider', agentId: channel.agentId, optionId };
    const command = resolveDeckAnswer(item, optionId);
    switch (command.kind) {
        case 'refused':
        case 'navigate':
        case 'restart-with-handoff':
            return command;
        default:
            return { kind: 'feature' };
    }
}

export function resolveDeckAnswer(item: DeckItem, optionId: string): DeckCommand {
    if (item.forwardedFrom !== null || item.answer.kind === 'elsewhere') {
        const host = item.answer.kind === 'elsewhere' ? item.answer.host : item.forwardedFrom;
        return refuse(`this question was raised on ${host} and must be answered there`);
    }
    if (item.answer.kind === 'form') return refuse('this question needs the full form; there is no one-click answer');
    if (!item.answer.options.some((o) => o.id === optionId)) return refuse(`${optionId} is not one of this item’s options`);

    switch (item.source) {
        case 'agent-question':
            if (item.id.startsWith('q_')) return { kind: 'answer-question', questionId: item.id, selections: [[optionId]], notes: [''], note: '' };
            if (item.id.startsWith('appr_')) return { kind: 'resolve-approval', approvalId: item.id, choice: optionId === 'allow' ? 'allow' : 'deny' };
            if (item.id.startsWith('approval:') && item.agentId) return { kind: 'answer-provider-approval', agentId: item.agentId, optionId };
            return refuse(`${item.id} is not an item Genie knows how to answer`);
        case 'user-list':
            if (item.workspaceId === null) return refuse('this item names no workspace; it cannot be marked done from here');
            return { kind: 'list-done', workspaceId: item.workspaceId, itemId: item.id };
        case 'unread-dm':
            return { kind: 'mark-read', messageId: item.id };
        case 'finished-handoff':
            if (optionId === 'open') return { kind: 'navigate', route: `genie://agent/${item.agentId}?tab=stream` };
            if (optionId === 'restart' && item.agentId) return { kind: 'restart-with-handoff', agentId: item.agentId, finishedId: item.id };
            return { kind: 'mark-seen', finishedId: item.id };
        case 'genie':
            // Genie's own asks, by id; one it does not know is refused, never guessed.
            if (item.id === TRUST_DECK_ID) return optionId === 'trust' ? { kind: 'trust-certificate' } : { kind: 'defer-trust-certificate' };
            return refuse(`${item.id} is not an item Genie knows how to answer`);
    }
}
