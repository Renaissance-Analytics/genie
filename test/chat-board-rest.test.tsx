import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chatAction } from '../src/core/keys.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE CHAT FLYOUT'S REMAINING BOARD RULES (`Chat Flyout.dc.html`): an approval parked in the chat is answered with
 * `A` / `D` there too (the letters follow the composer — one actionable rendering); `Stop this turn` sits on the context
 * line while a turn runs that can be stopped (it used to sit under Send and end the agent); a broken session ends the transcript with the red error rule (`stream closed · exit 137 · 14:31`).
 */
const base: ChatThread = { agentId: 'a1', name: 'lark', fidelity: 'declared', unread: null, context: { text: 'Working', tone: 'ok' }, chips: [], messages: [] };
const render = (t: ChatThread, extra: Partial<Parameters<typeof ChatFlyout>[0]> = {}) =>
    renderToStaticMarkup(<ChatFlyout thread={t} onSend={() => {}} onClose={() => {}} {...extra} />);

describe('A / D in the chat', () => {
    const press = (key: string, typing = false) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing });
    it('allow / deny only when the chat holds the actionable approval, never while typing', () => {
        expect(chatAction(press('a'), { open: true, approval: true })).toBe('allow');
        expect(chatAction(press('d'), { open: true, approval: true })).toBe('deny');
        expect(chatAction(press('a'), { open: true, approval: false })).toBeNull();
        expect(chatAction(press('a', true), { open: true, approval: true })).toBeNull();
    });
});

describe('Stop and the error rule', () => {
    it('`Stop this turn` sits on the context line, with the turn — never under Send; absent when the turn cannot be stopped', () => {
        const html = render(base, { onStopTurn: () => {} });
        // The context line runs from its own element to the thread's scroller, the next thing in the panel.
        expect(html.indexOf('data-chat-context="ok"')).toBeGreaterThan(-1);
        const line = html.slice(html.indexOf('data-chat-context="ok"'), html.indexOf('data-chat-scroll'));
        expect(line.split('data-action="stop-turn"').length - 1).toBe(1);
        expect(line).toContain('Stop this turn');
        expect(html.split('data-action="stop-turn"').length - 1).toBe(1);
        expect(html).not.toContain('chat-stop');
        expect(render(base)).not.toContain('stop-turn');
    });

    it('a broken session ends the transcript with the red rule naming the failure; a working one has none', () => {
        const broken = render({ ...base, context: { text: 'Broken · ACP stream closed · exit 137', tone: 'bad' } });
        expect(broken).toMatch(/data-chat-error[^>]*>[^<]*(<[^>]*>[^<]*)*ACP stream closed · exit 137/);
        expect(render(base)).not.toContain('data-chat-error');
    });
});
