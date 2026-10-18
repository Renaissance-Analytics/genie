import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';
import { CHAT_DOCK_DEFAULT, CHAT_DOCK_WIDTH_KEY, atThreadEnd } from '../src/core/chat-width.js';

/**
 * THE OWNER, 2026-10-13: "The chat message panel doesn't have a scroll bar so I can't scroll to see messages at all"
 * and "I need to be able to also resize the chat flyout and have it remember the size … Pinning does not use that
 * flyout size, it should use the size you designed it for already."
 *
 * THE SCROLL BUG'S CAUSE: the message list was ONE element that was both the scroller (`overflow-auto`) and a
 * bottom-packed column (`flex-col justify-end`). A flex container packed to the end overflows at its START, and
 * overflow at the start of a scroll container is unreachable — so a long thread had its top cut off and no scrollbar
 * at all (the screenshot: the reply begins mid-sentence under the context line). The fix splits the two jobs: an
 * outer scroller, and an inner column at least as tall as it (`min-h-full`) that packs short threads to the bottom
 * and grows downward — scrollable — when long.
 *
 * jsdom/static markup cannot measure layout, so the scroll half asserts that STRUCTURAL cause, not a scroll position:
 * no element is both the scroller and end-packed; the scroller is the bounded flex child; the end-packing lives
 * inside it. Not proven here: pixels in a real window.
 */

const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, who: 'agent' as const, from: 'genie', text: `reply ${i}`, delivered: true, at: null }));
const thread: ChatThread = { agentId: 'genie', name: 'genie', fidelity: 'declared', unread: null, messages: many };
const memory = (value: string | null) => {
    const m = new Map<string, string>(value === null ? [] : [[CHAT_DOCK_WIDTH_KEY, value]]);
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, map: m };
};
const render = (stored: string | null = null) =>
    renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} widthStorage={memory(stored)} />);
const classOf = (html: string, attr: string) => (html.match(new RegExp(`<[^>]*${attr}[^>]*class="([^"]*)"`)) ?? html.match(new RegExp(`<[^>]*class="([^"]*)"[^>]*${attr}`)))?.[1]?.split(/\s+/) ?? null;

describe('the chat thread scrolls', () => {
    it('no element is both the scroller and end-packed — counted over every element, so the old shape is named', () => {
        const html = render();
        const both = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!.split(/\s+/)).filter((c) => c.some((x) => /^overflow(-y)?-auto$/.test(x)) && c.includes('justify-end'));
        expect(both).toEqual([]);
    });

    it('the scroller is the bounded flex child (flex-1, min-h-0, overflow-y-auto) and holds the messages', () => {
        const html = render();
        const scroller = classOf(html, 'data-chat-scroll=""');
        expect(scroller).not.toBeNull();
        expect(scroller).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']));
        // Positive control: the messages are inside it — all 40.
        const inside = html.slice(html.indexOf('data-chat-scroll=""'));
        expect((inside.match(/data-chat-message="/g) ?? []).length).toBe(40);
    });

    it('short threads still sit at the bottom: the end-packing lives on an inner column at least as tall as the scroller', () => {
        const log = classOf(render(), 'data-chat-log=""');
        expect(log).toEqual(expect.arrayContaining(['flex', 'flex-col', 'justify-end', 'min-h-full']));
    });

    it('follows the end only when the person is at the end', () => {
        expect(atThreadEnd(1000, 1600, 600)).toBe(true);
        expect(atThreadEnd(995, 1600, 600)).toBe(true);
        expect(atThreadEnd(400, 1600, 600)).toBe(false);
    });
});

describe('the chat is resizable and remembers its width (Tynn #798)', () => {
    it('the remembered width, and a left-edge separator to drag', () => {
        const html = render('700');
        expect(html).toMatch(/data-chat="pinned"[^>]*style="width:700px"|style="width:700px"[^>]*data-chat="pinned"/);
        expect(html).toMatch(/role="separator"[^>]*data-chat-resize=""|data-chat-resize=""[^>]*role="separator"/);
    });

    it('nothing remembered = the designed width', () => {
        expect(render()).toContain(`style="width:${CHAT_DOCK_DEFAULT}px"`);
    });
});
