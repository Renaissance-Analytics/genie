import { describe, expect, it } from 'vitest';
import { deckBand, needsYouCount, type DeckItem } from '../src/core/deck.js';

/**
 * **Needs you** (§4.5): everything waiting on a human, ranked; the rail's badge is its count. A finished agent's handoff
 * is not on the Deck at all — it is for agents, never read or cleared by the person (Tynn #658), so there is no second
 * band of handoffs to read.
 */
const item = (over: Partial<DeckItem>): DeckItem => ({
    id: 'q_1', source: 'agent-question', agentId: 'kai', agentName: 'kai', workspaceId: 'tynn', title: 'Which engine?',
    blocking: true, priority: 'normal', at: 10, answer: { kind: 'inline', options: [{ id: 'a', label: 'a', tone: 'neutral' }] }, forwardedFrom: null, ...over,
});

const items = [item({ id: 'q_1', at: 10 }), item({ id: 'li_1', source: 'user-list', blocking: false, at: 1 }), item({ id: 'msg_1', source: 'unread-dm', blocking: false, priority: 'low', at: 0 })];

describe('Needs you', () => {
    it('holds every item, blocking first; its count is the badge', () => {
        expect(deckBand(items).map((i) => i.id)).toEqual(['q_1', 'li_1', 'msg_1']);
        expect(needsYouCount(items)).toBe(3);
        expect(needsYouCount([])).toBe(0);
    });
});
