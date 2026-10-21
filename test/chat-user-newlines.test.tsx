import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';

/**
 * WHAT YOU TYPED KEEPS ITS LINES (the owner, 2026-10-21, a screenshot of his own message run together: "user input is not
 * honoring new lines in the display"). The composer keeps every newline and the agent receives them; the bubble showing
 * your message rendered it as plain text in HTML, which collapses them. It now keeps them (pre-wrap) and still wraps a
 * long line — a URL included — instead of running off the bubble.
 */
const TEXT = 'first line\nsecond line\n\nafter a blank line https://example.com/a/very/long/path/that/must/wrap';

const html = () => renderToStaticMarkup(
    <ChatFlyout
        thread={{ agentId: 'a_lark', name: 'lark', fidelity: 'declared', unread: null, messages: [{ id: 'm1', who: 'you', from: 'you', text: TEXT, delivered: true, at: null }] } as never}
        onSend={() => {}}
        onClose={() => {}}
    />,
);

describe('your message, as you typed it', () => {
    it('the bubble keeps its newlines (pre-wrap) and breaks a long word rather than overflow', () => {
        const bubble = /<div[^>]*data-chat-user-text=""[^>]*>([^<]*)</.exec(html());
        expect(bubble).not.toBeNull();
        expect(bubble![0]).toMatch(/whitespace-pre-wrap/);
        expect(bubble![0]).toMatch(/break-words/);
        // The text itself arrives with its newlines (the markup does not flatten them).
        expect(bubble![1]).toBe(TEXT.replace(/&/g, '&amp;'));
    });

    it('CONTROL: exactly one such bubble — the agent’s replies render through their own Markdown path', () => {
        expect((html().match(/data-chat-user-text=""/g) ?? []).length).toBe(1);
    });
});
