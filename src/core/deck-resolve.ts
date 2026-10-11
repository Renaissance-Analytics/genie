import type { DeckItem } from './deck.js';

/**
 * RESOLVING A DECK ITEM IN PLACE (§4.5) — what pressing an option on each kind MEANS, as a plain
 * command the main process executes. Pure: every branch is here, and the dispatcher in main is a
 * switch with no judgement in it. An answer that makes no sense for its source is refused, never
 * guessed into the nearest thing — a Deck that "helpfully" marked a question done because the user
 * pressed the only button is a Deck that lost a decision.
 *
 * The item id's prefix is the item's ORIGIN, decided by whoever minted it: `q_` the attention
 * store's questions, `appr_` the approval queue, `approval:<agent>` a provider's permission request
 * (the session layer), `li_` list items, `msg_` mail, `fin_` finishes.
 */

export type DeckCommand =
    | { kind: 'answer-question'; questionId: string; selections: string[][]; note: string }
    | { kind: 'resolve-approval'; approvalId: string; choice: 'allow' | 'deny' }
    | { kind: 'answer-provider-approval'; agentId: string; optionId: string }
    | { kind: 'list-done'; workspaceId: string; itemId: string }
    | { kind: 'mark-read'; messageId: string }
    | { kind: 'mark-seen'; finishedId: string }
    | { kind: 'restart-with-handoff'; agentId: string; finishedId: string }
    | { kind: 'navigate'; route: string }
    | { kind: 'refused'; reason: string };

const refuse = (reason: string): DeckCommand => ({ kind: 'refused', reason });

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
            if (item.id.startsWith('q_')) return { kind: 'answer-question', questionId: item.id, selections: [[optionId]], note: '' };
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
    }
}
