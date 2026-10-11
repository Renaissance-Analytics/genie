import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { alertsBetween } from '../src/core/alert-diff.js';

/**
 * WHICH ALERTS JUST HAPPENED (§6.3) — derived from two consecutive snapshots, never from a timer: a
 * Deck item that was not there before is a question / approval / finish / mail alert by its origin
 * prefix; an agent row that turned broken is a broken alert. Items that merely persist alert nobody
 * twice; the first snapshot after boot alerts nobody at all (there was no "before").
 */

const item = (id: string, source: DeckItem['source'], over: Partial<DeckItem> = {}): DeckItem =>
    ({ id, source, agentId: 'agent_a', agentName: 'atlas', workspaceId: 'tynn', title: 'Ship now?', blocking: true, priority: 'normal', at: 0, answer: { kind: 'inline', options: [] }, forwardedFrom: null, ...over }) as DeckItem;
const row = (id: string, state: string) => ({ id, name: 'atlas', workspaceId: 'tynn', state, reason: state === 'broken' ? 'exited with code 1' : null });

describe('alertsBetween', () => {
    it('a new question, approval, finish or mail item is one alert each, naming workspace, agent and the detail', () => {
        const prev = { deckItems: [item('q_old', 'agent-question')], agents: [] };
        const next = { deckItems: [item('q_old', 'agent-question'), item('q_1', 'agent-question'), item('appr_1', 'agent-question', { title: 'Run tests?' }), item('fin_1', 'finished-handoff', { title: 'atlas finished: PR up' }), item('msg_1', 'unread-dm', { agentName: 'wren', title: 'wren: ping' })], agents: [] };
        expect(alertsBetween(prev, next)).toEqual([
            { kind: 'question', workspace: 'tynn', agent: 'atlas', detail: 'Ship now?' },
            { kind: 'approval', workspace: 'tynn', agent: 'atlas', detail: 'Run tests?' },
            { kind: 'finished', workspace: 'tynn', agent: 'atlas', detail: 'atlas finished: PR up' },
            { kind: 'mail', workspace: 'tynn', agent: 'wren', detail: 'wren: ping' },
        ]);
    });

    it('an agent that TURNED broken alerts once with its reason; one already broken does not; nothing alerts on the first snapshot', () => {
        const prev = { deckItems: [], agents: [row('agent_a', 'working'), row('agent_b', 'broken')] };
        const next = { deckItems: [], agents: [row('agent_a', 'broken'), row('agent_b', 'broken')] };
        expect(alertsBetween(prev, next)).toEqual([{ kind: 'broken', workspace: 'tynn', agent: 'atlas', detail: 'exited with code 1' }]);
        expect(alertsBetween(null, next)).toEqual([]);
        expect(alertsBetween(next, next)).toEqual([]);
    });
});
