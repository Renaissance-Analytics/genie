import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE UNDELIVERED MESSAGE ON SCREEN (the board's `failed` shape): your bubble with a dashed red border, "Not delivered.
 * <agent> is not running.", and `[Restart <agent> and send]`. Never dropped, never shown as sent.
 */
const thread: ChatThread = {
    agentId: 'a1', name: 'lark', fidelity: 'declared', unread: null, context: { text: 'Broken · ACP stream closed', tone: 'bad' },
    messages: [{ id: 'd1', who: 'you', from: 'you', text: 'Use 4 workers instead.', delivered: false, at: 1_700_000_000_000 }],
};
const render = (t: ChatThread) =>
    renderToStaticMarkup(<ChatFlyout thread={t} onSend={() => {}} onClose={() => {}} onRestartAndSend={() => {}} />);

describe('an undelivered message', () => {
    it('is kept, marked with the agent’s name, and offers Restart <agent> and send', () => {
        const html = render(thread);
        expect(html).toContain('data-chat-undelivered="d1"');
        expect(html).toContain('Not delivered. lark is not running.');
        expect(html).toMatch(/<button[^>]*data-action="restart-and-send"[^>]*data-draft="d1"[^>]*>Restart lark and send<\/button>/);
    });

    it('a delivered message carries none of that (positive control)', () => {
        const html = render({ ...thread, messages: [{ ...thread.messages[0]!, delivered: true }] });
        expect(html).not.toContain('data-chat-undelivered');
        expect(html).not.toContain('restart-and-send');
    });
});
