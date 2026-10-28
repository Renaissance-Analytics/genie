import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from '../src/core/route.js';

/**
 * THE DECK ROUTE NAMES ONE ITEM (`genie://deck?item=<id>`): an approval toast's "Open Deck" and the workspace
 * dashboard's "waiting on you" Open use it. A Dashboard ROW is no longer a door to it (the owner, 2026-10-28: the
 * Dashboard stays and the chat becomes that agent's — test/dashboard-agent-click-stays.test.tsx).
 */
describe('the deck route names one item', () => {
    it('parses `?item=` and formats it back; absent → null', () => {
        expect(parseRoute('genie://deck?item=approval:kai')).toMatchObject({ surface: 'deck', item: 'approval:kai' });
        expect(parseRoute('genie://deck')).toMatchObject({ surface: 'deck', item: null });
        expect(formatRoute({ surface: 'deck', item: 'q_1', chat: null, pin: null })).toBe('genie://deck?item=q_1');
        expect(formatRoute({ surface: 'deck', item: null, chat: null, pin: null })).toBe('genie://deck');
    });
});
