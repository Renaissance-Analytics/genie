import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CHAT_LIVE_LINES, chatWindowStart, messageLines } from '../src/core/chat-window.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * FOLLOWING LIVE = THE LAST 500 LINES (the owner, 2026-10-22: "are we redrawing the whole chat and work streams every
 * time they update? history should buffer with only the last 500 lines present when Following Live").
 *
 * The chat drew EVERY message of an agent's history as Markdown DOM — thousands for a long-running agent — and redrew
 * them on each of up to 20 pushes a second; the window froze and mouse movement over Genie lagged (hit-testing a huge
 * DOM). Now the chat holds the last 500 LINES of the thread in the DOM; the rest stays in memory and pages in, 500 lines
 * at a time, when the person asks for earlier messages. MEASURED as the number of messages in the markup at 3,000 and
 * at 100,000 messages: the same.
 */

const msg = (i: number, text = `reply ${i}`) => ({ id: `m${i}`, who: 'agent' as const, from: 'atlas', text, delivered: true, at: null });
const thread = (messages: ReturnType<typeof msg>[]): ChatThread => ({ agentId: 'agent_a', name: 'atlas', fidelity: 'declared', unread: null, messages });
const rendered = (html: string) => [...html.matchAll(/data-chat-message="([^"]+)"/g)].map((m) => m[1]!);
const render = (t: ChatThread) => renderToStaticMarkup(<ChatFlyout thread={t} onSend={() => {}} onClose={() => {}} />);

describe('the window: lines, from the end', () => {
    it('a message is as many lines as its text has (at least one)', () => {
        expect(messageLines({ text: '' })).toBe(1);
        expect(messageLines({ text: 'one' })).toBe(1);
        expect(messageLines({ text: 'a\nb\nc' })).toBe(3);
    });

    it('starts where the last 500 lines begin; everything when the thread is shorter; never past the last message', () => {
        const ones = Array.from({ length: 3000 }, (_, i) => ({ text: `l${i}` }));
        expect(CHAT_LIVE_LINES).toBe(500);
        expect(chatWindowStart(ones, 500)).toBe(2500);
        expect(chatWindowStart(ones.slice(0, 40), 500)).toBe(0);
        // Ten-line messages: 50 of them make 500 lines.
        const tens = Array.from({ length: 300 }, () => ({ text: Array.from({ length: 10 }, () => 'x').join('\n') }));
        expect(chatWindowStart(tens, 500)).toBe(250);
        // One huge last message is still shown whole: the window never cuts the message being written.
        expect(chatWindowStart([...ones.slice(0, 10), { text: Array.from({ length: 2000 }, () => 'y').join('\n') }], 500)).toBe(10);
        expect(chatWindowStart([], 500)).toBe(0);
    });

    it('paging in earlier history widens the window by whole messages', () => {
        const ones = Array.from({ length: 3000 }, (_, i) => ({ text: `l${i}` }));
        expect(chatWindowStart(ones, 1000)).toBe(2000);
        expect(chatWindowStart(ones, 1_000_000)).toBe(0);
    });
});

describe('what the chat draws', () => {
    it('3,000 one-line messages: the last 500 in the DOM, the newest included, and the earlier ones offered', () => {
        const html = render(thread(Array.from({ length: 3000 }, (_, i) => msg(i))));
        const ids = rendered(html);
        expect(ids).toHaveLength(500);
        expect(ids[0]).toBe('m2500');
        expect(ids.at(-1)).toBe('m2999');
        expect(html).toMatch(/data-chat-earlier="2500"/);
    });

    it('FLAT: 100,000 messages draw exactly as many as 3,000', () => {
        const big = rendered(render(thread(Array.from({ length: 100_000 }, (_, i) => msg(i)))));
        expect(big).toHaveLength(500);
        expect(big.at(-1)).toBe('m99999');
    });

    it('a thread derived from the ledger’s tail (core/chat-view.ts chatTailStart) offers the history behind it', () => {
        const html = render({ ...thread(Array.from({ length: 40 }, (_, i) => msg(i))), earlier: true });
        expect(rendered(html)).toHaveLength(40);
        expect(html).toMatch(/data-chat-earlier="more"[^>]*>Earlier messages · show more</);
    });

    it('CONTROL: a short thread draws every message and offers nothing earlier', () => {
        const html = render(thread(Array.from({ length: 40 }, (_, i) => msg(i))));
        expect(rendered(html)).toHaveLength(40);
        expect(html).not.toContain('data-chat-earlier');
    });
});
