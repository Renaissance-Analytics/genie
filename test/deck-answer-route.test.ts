import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { deckAnswerRoute } from '../src/core/deck-resolve.js';

/**
 * WHERE A DECK ANSWER GOES — the renderer's one decision, made here so the App has no judgement in
 * it: a provider approval back through the session layer; everything else is a feature action main
 * resolves against the stores. A refusal is said, not guessed around. (A finished agent's handoff is
 * no Deck item, so it has no Open / Restart with this / mark read here: Tynn #658.)
 */

const base = (over: Partial<DeckItem>): DeckItem => ({
    id: 'x', source: 'agent-question', agentId: 'agent_a', agentName: 'atlas', workspaceId: 'tynn', title: 't',
    blocking: true, priority: 'normal', at: 0, answer: { kind: 'inline', options: [{ id: 'a', label: 'a', tone: 'neutral' }] }, forwardedFrom: null,
    ...over,
});
describe('deckAnswerRoute', () => {
    it('a provider approval goes back through the session layer with the provider’s option id', () => {
        expect(deckAnswerRoute(base({ id: 'approval:agent_a' }), 'allow')).toEqual({ kind: 'provider', agentId: 'agent_a', optionId: 'allow', note: '' }); // the note (item 16): none given
        expect(deckAnswerRoute(base({ id: 'approval:agent_a', agentId: null }), 'allow')).toEqual({ kind: 'refused', reason: 'this approval names no agent' });
    });

    it('questions, list items and mail are feature actions; a forwarded item is refused with where it must be answered', () => {
        expect(deckAnswerRoute(base({ id: 'q_1' }), 'a')).toEqual({ kind: 'feature' });
        expect(deckAnswerRoute(base({ id: 'li_1', source: 'user-list' }), 'a')).toEqual({ kind: 'feature' });
        expect(deckAnswerRoute(base({ id: 'msg_1', source: 'unread-dm' }), 'a')).toEqual({ kind: 'feature' });
        expect(deckAnswerRoute(base({ id: 'q_1', forwardedFrom: 'studio' }), 'a')).toEqual({ kind: 'refused', reason: 'this question was raised on studio and must be answered there' });
        expect(deckAnswerRoute(base({ id: 'q_1' }), 'nope')).toEqual({ kind: 'refused', reason: 'nope is not one of this item’s options' });
    });
});
