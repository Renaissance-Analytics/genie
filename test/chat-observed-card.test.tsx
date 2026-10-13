import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE OBSERVED FACT CARD (the board's `Chat Flyout`, the observed state): a Take Over window's chat is a different
 * SHAPE — mail into its inbox, no replies shown — and the flyout says so once, at the top of the thread, instead of
 * leaving an empty transcript that reads as an agent ignoring you. A declared agent's thread carries no such card.
 */
const render = (thread: ChatThread) =>
    renderToStaticMarkup(<ChatFlyout thread={thread} pinned={false} contextTokens={0} onSend={() => {}} onTogglePin={() => {}} onClose={() => {}} />);

describe('the observed fact card', () => {
    it('names the agent and says what the chat is, above the thread, beside the mail-only chip', () => {
        const html = render({ agentId: 'kora', name: 'kora', fidelity: 'observed', unread: null, messages: [] });
        expect(html).toMatch(/data-chat-fact="observed"[^>]*>kora runs in a terminal\. What you send here lands in its inbox/);
        expect(html).toContain('mail it sends you shows here. Its replies in the terminal are not shown');
        expect(html).toContain('data-chat-chip="mail-only"');
    });

    it('is absent for a declared agent (positive control: the same flyout, a declared thread)', () => {
        const html = render({ agentId: 'kai', name: 'kai', fidelity: 'declared', unread: null, messages: [] });
        expect(html).not.toContain('data-chat-fact');
        expect(html).not.toContain('runs in a terminal');
    });
});
