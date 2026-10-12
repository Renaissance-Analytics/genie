import { describe, expect, it } from 'vitest';
import { carryPinnedChat, parseRoute } from '../src/core/route.js';
import { withDrafts, type Draft } from '../src/core/chat-view.js';

/**
 * TWO MORE RULES OF THE CHAT FLYOUT (§4.4), from the board audit of 2026-10-12.
 *
 * 1. **An undelivered message is kept and marked, with the route to send it.** The session host returns `false` when
 *    the agent is not running; the renderer used to ignore it and the text vanished. Now a draft is kept per agent and
 *    shown in the thread as `you`, not delivered, with `Restart X and send`.
 * 2. **A pinned chat's subject does not follow the view.** The rail's routes are literals, so every navigation dropped
 *    `chat=&pin=` and the pinned flyout vanished. Navigation now carries a PINNED chat's subject onto the next route.
 */
const thread = { agentId: 'a1', name: 'atlas', fidelity: 'declared' as const, unread: null, messages: [{ id: 'e1', who: 'you' as const, from: 'you', text: 'hi', delivered: true, at: 1_000 }], context: null, chips: [] };

describe('withDrafts', () => {
    it('appends this agent’s undelivered drafts after the wire messages, as you, not delivered, with their time', () => {
        const drafts: Draft[] = [{ id: 'd1', agentId: 'a1', text: 'Use 4 workers instead.', at: 2_000 }, { id: 'd2', agentId: 'zz', text: 'other agent', at: 3_000 }];
        const out = withDrafts(thread, drafts);
        expect(out.messages.map((m) => [m.id, m.who, m.delivered, m.at])).toEqual([['e1', 'you', true, 1_000], ['d1', 'you', false, 2_000]]);
        expect(out.messages[1]).toMatchObject({ from: 'you', text: 'Use 4 workers instead.' });
    });

    it('no drafts: the thread unchanged (same messages, COUNT held)', () => {
        expect(withDrafts(thread, []).messages).toHaveLength(1);
    });
});

describe('carryPinnedChat', () => {
    const current = parseRoute('genie://dashboard?group=workspace&chat=a1&pin=right');

    it('a PINNED chat rides onto a route that names no chat', () => {
        expect(carryPinnedChat('genie://workspace/tynn', current, true)).toBe('genie://workspace/tynn?chat=a1&pin=right');
        expect(carryPinnedChat('genie://deck', current, true)).toBe('genie://deck?chat=a1&pin=right');
    });

    it('an UNPINNED chat does not follow — it is an overlay on the view you were on', () => {
        expect(carryPinnedChat('genie://deck', parseRoute('genie://dashboard?chat=a1'), false)).toBe('genie://deck');
    });

    it('a route that names its own chat, or closes it, is left alone; so is one with no chat open', () => {
        expect(carryPinnedChat('genie://deck?chat=wren', current, true)).toBe('genie://deck?chat=wren');
        expect(carryPinnedChat('genie://deck', parseRoute('genie://dashboard'), true)).toBe('genie://deck');
    });
});
