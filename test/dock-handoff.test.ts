import { describe, expect, it } from 'vitest';
import { pinPanel, routeAfterPin } from '../src/core/dock.js';

/**
 * THE DOCK'S HANDOFF IN THE ROUTE (§4.4): the chat is open while the route names it (`chat=`), and an open chat is always
 * docked (2026-10-17). When pinning the file panel displaces the chat, the chat leaves the route — a stale `chat=`
 * reopens it in the dock on the next navigation and the handoff the person just saw is undone behind their back. An
 * old link's `pin=` goes with it. Anything that leaves the chat alone leaves the route alone.
 */
describe('routeAfterPin', () => {
    it('drops the chat (and any old `pin=`) when the chat was the panel displaced, keeping every other parameter', () => {
        const out = pinPanel('chat', 'files', false);
        expect(out).toEqual({ pinned: 'files', replaced: 'chat', refused: null });
        expect(routeAfterPin('genie://agent/kai?tab=stream&chat=kai&pin=right', out)).toBe('genie://agent/kai?tab=stream');
        expect(routeAfterPin('genie://dashboard?group=workspace&pin=right&chat=genie', out)).toBe('genie://dashboard?group=workspace');
        expect(routeAfterPin('genie://deck?chat=genie', out)).toBe('genie://deck');
    });

    it('leaves the route alone when the chat was not displaced — pinning the chat, pinning files over nothing, a refusal', () => {
        const r = 'genie://agent/kai?tab=stream&chat=kai&pin=right';
        expect(routeAfterPin(r, pinPanel(null, 'chat', false))).toBe(r);
        expect(routeAfterPin(r, pinPanel(null, 'files', false))).toBe(r);
        expect(routeAfterPin(r, pinPanel('files', 'chat', true))).toBe(r);
        expect(routeAfterPin(r, pinPanel('files', 'files', false))).toBe(r);
    });
});
