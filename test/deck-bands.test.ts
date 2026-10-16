import { describe, expect, it } from 'vitest';
import { deckBand, needsYouCount, sinceYouLooked, type DeckItem } from '../src/core/deck.js';

/**
 * TWO BANDS (§4.5): **Needs you** — everything waiting on a human, ranked — and **Since you looked** — agents that
 * finished with a handoff note, newest first, each with `Open` / `Restart with this` / `mark read`. A finished agent
 * is not waiting on anybody, so it is not in the first band and not in its count; the rail's badge is that count.
 */
const item = (over: Partial<DeckItem>): DeckItem => ({
    id: 'q_1', source: 'agent-question', agentId: 'kai', agentName: 'kai', workspaceId: 'tynn', title: 'Which engine?',
    blocking: true, priority: 'normal', at: 10, answer: { kind: 'inline', options: [{ id: 'a', label: 'a', tone: 'neutral' }] }, forwardedFrom: null, ...over,
});
const fin = (id: string, at: number, name = 'atlas'): DeckItem =>
    item({ id, source: 'finished-handoff', agentId: name, agentName: name, title: `${name} finished: PR #15 is up; the front door is next.`, blocking: false, at,
        answer: { kind: 'inline', options: [{ id: 'open', label: 'Open', tone: 'neutral' }, { id: 'restart', label: 'Restart with this', tone: 'neutral' }, { id: 'seen', label: 'mark read', tone: 'neutral' }] } });

const items = [fin('fin_1', 5), item({ id: 'q_1', at: 10 }), fin('fin_2', 20, 'wren'), item({ id: 'li_1', source: 'user-list', blocking: false, at: 1 })];

describe('the two bands', () => {
    it('Needs you holds everything but the finished handoffs, still ranked; its count is the badge', () => {
        expect(deckBand(items).map((i) => i.id)).toEqual(['q_1', 'li_1']);
        expect(needsYouCount(items)).toBe(2);
        expect(needsYouCount([fin('fin_1', 5)])).toBe(0);
    });

    it('Since you looked holds the finished handoffs, newest first', () => {
        expect(sinceYouLooked(items).map((i) => i.id)).toEqual(['fin_2', 'fin_1']);
        expect(sinceYouLooked([item({})])).toEqual([]);
    });
});
