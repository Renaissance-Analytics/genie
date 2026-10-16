import { describe, expect, it } from 'vitest';
import { deckItemFor, type DeckItem } from '../src/core/deck.js';
import { formatRoute, parseRoute } from '../src/core/route.js';

/**
 * A WAITING ROW IS A DOOR TO ITS DECK ITEM (§4.1: "a waiting row links to its Deck item and is answered there —
 * the Deck resolves, the Dashboard shows"). The Deck route can name one item (`genie://deck?item=<id>`), and the
 * item for an agent is the blocking question it is waiting on — never a finished handoff, never a guess.
 */
const item = (over: Partial<DeckItem>): DeckItem => ({
    id: 'approval:kai', source: 'agent-question', agentId: 'kai', agentName: 'kai', workspaceId: 'tynn',
    title: 'Allow php artisan migrate --force?', blocking: true, priority: 'normal', at: 1,
    answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] }, forwardedFrom: null, ...over,
});

describe('the deck route names one item', () => {
    it('parses `?item=` and formats it back; absent → null', () => {
        expect(parseRoute('genie://deck?item=approval:kai')).toMatchObject({ surface: 'deck', item: 'approval:kai' });
        expect(parseRoute('genie://deck')).toMatchObject({ surface: 'deck', item: null });
        expect(formatRoute({ surface: 'deck', item: 'q_1', chat: null, pin: null })).toBe('genie://deck?item=q_1');
        expect(formatRoute({ surface: 'deck', item: null, chat: null, pin: null })).toBe('genie://deck');
    });
});

describe('deckItemFor', () => {
    it('the blocking question the agent is waiting on; the oldest when there are two', () => {
        const items = [item({ id: 'q_2', at: 5 }), item({ id: 'q_1', at: 2 }), item({ id: 'fin_1', source: 'finished-handoff', blocking: false, at: 1 })];
        expect(deckItemFor('kai', items)).toBe('q_1');
    });

    it('null when the agent has no question waiting — a finished handoff or another agent’s question is not a door', () => {
        expect(deckItemFor('kai', [item({ id: 'fin_1', source: 'finished-handoff', blocking: false })])).toBeNull();
        expect(deckItemFor('kai', [item({ id: 'q_9', agentId: 'wren' })])).toBeNull();
        expect(deckItemFor('kai', [])).toBeNull();
    });
});
