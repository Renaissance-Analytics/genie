import { describe, expect, it } from 'vitest';
import { pinPanel, routeAfterPin } from '../src/core/dock.js';

/**
 * THE DOCK'S HANDOFF IN THE ROUTE (§4.4): `?pin=right` says the CHAT is pinned. When pinning the file panel displaces
 * the chat, the route must stop saying so — a stale `pin=right` reopens the chat pinned on the next navigation and the
 * handoff the user just saw is undone behind their back. Pinning the chat itself, or anything that leaves the chat
 * alone, leaves the route alone.
 */
describe('routeAfterPin', () => {
    it('drops `pin=right` when the chat was the panel displaced', () => {
        const out = pinPanel('chat', 'files', false);
        expect(out).toEqual({ pinned: 'files', replaced: 'chat', refused: null });
        expect(routeAfterPin('genie://agent/kai?tab=stream&chat=kai&pin=right', out)).toBe('genie://agent/kai?tab=stream&chat=kai');
        expect(routeAfterPin('genie://dashboard?group=workspace&pin=right&chat=genie', out)).toBe('genie://dashboard?group=workspace&chat=genie');
    });

    it('leaves the route alone when the chat was not displaced — pinning the chat, pinning files over nothing, a refusal', () => {
        const r = 'genie://agent/kai?tab=stream&chat=kai&pin=right';
        expect(routeAfterPin(r, pinPanel(null, 'chat', false))).toBe(r);
        expect(routeAfterPin(r, pinPanel(null, 'files', false))).toBe(r);
        expect(routeAfterPin(r, pinPanel('files', 'chat', true))).toBe(r);
        expect(routeAfterPin(r, pinPanel('files', 'files', false))).toBe(r);
    });
});
