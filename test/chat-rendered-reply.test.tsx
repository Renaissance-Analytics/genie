import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * A REPLY IS RENDERED, NOT SHOWN AS RAW MARKDOWN (the owner, using beta.19: "The chat response also need to use the
 * content renderer component from fancy so it's not raw markdown"). An agent's (or a peer's) message goes through
 * react-fancy's ContentRenderer as Markdown, with its default sanitising left on. That sanitiser parses with the
 * browser's DOMParser, so it runs in the app's renderer and is a no-op in Node: these server-side tests cannot prove
 * it, and do not pretend to. Your own message stays exactly as you typed it.
 */
const render = (messages: ChatThread['messages']) =>
    renderToStaticMarkup(<ChatFlyout thread={{ agentId: 'moic', name: 'moic', fidelity: 'declared', unread: null, messages }} onSend={() => {}} onClose={() => {}} />);

describe('the agent\'s reply', () => {
    it('renders Markdown: bold, code and a list — no asterisks left on screen', () => {
        const html = render([{ id: 'a', who: 'agent', from: 'moic', text: '**The product:** `repos/moic-suite`\n\n- one\n- two', delivered: true }]);
        expect(html).toMatch(/data-chat-message="a"[\s\S]*<strong>The product:<\/strong>/);
        expect(html).toMatch(/<code[^>]*>repos\/moic-suite<\/code>/);
        expect((html.match(/<li[ >]/g) ?? []).length).toBe(2);
        expect(html).not.toContain('**The product:**');
    });

    it('your own message is shown as you typed it (positive control: the same Markdown, not rendered)', () => {
        const html = render([{ id: 'y', who: 'you', from: 'you', text: '**not bold**', delivered: true }]);
        expect(html).toContain('**not bold**');
        expect(html).not.toContain('<strong>not bold</strong>');
    });
});
