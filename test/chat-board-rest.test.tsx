import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chatAction } from '../src/core/keys.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE CHAT FLYOUT'S REMAINING BOARD RULES (`Chat Flyout.dc.html`): an approval parked in the chat is answered with
 * `A` / `D` there too (the letters follow the composer — one actionable rendering); `[Stop]` sits beside Send while a
 * turn runs; a broken session ends the transcript with the red error rule (`stream closed · exit 137 · 14:31`).
 */
const base: ChatThread = { agentId: 'a1', name: 'lark', fidelity: 'declared', unread: null, context: { text: 'Working', tone: 'ok' }, chips: [], messages: [] };
const render = (t: ChatThread, extra: Partial<Parameters<typeof ChatFlyout>[0]> = {}) =>
    renderToStaticMarkup(<ChatFlyout thread={t} pinned={false} onSend={() => {}} onTogglePin={() => {}} onClose={() => {}} {...extra} />);

describe('A / D in the chat', () => {
    const press = (key: string, typing = false) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing });
    it('allow / deny only when the chat holds the actionable approval, never while typing; Esc still closes an unpinned flyout', () => {
        expect(chatAction(press('a'), { open: true, pinned: true, approval: true })).toBe('allow');
        expect(chatAction(press('d'), { open: true, pinned: false, approval: true })).toBe('deny');
        expect(chatAction(press('a'), { open: true, pinned: true, approval: false })).toBeNull();
        expect(chatAction(press('a', true), { open: true, pinned: true, approval: true })).toBeNull();
        expect(chatAction(press('Escape'), { open: true, pinned: false })).toBe('close-chat');
    });
});

describe('Stop and the error rule', () => {
    it('[Stop] beside Send while a turn runs; absent otherwise', () => {
        expect(render(base, { running: true, onStop: () => {} })).toMatch(/<button[^>]*data-action="chat-stop"[^>]*>[^<]*(<[^>]*>[^<]*)*Stop/);
        expect(render(base, { running: false, onStop: () => {} })).not.toContain('chat-stop');
    });

    it('a broken session ends the transcript with the red rule naming the failure; a working one has none', () => {
        const broken = render({ ...base, context: { text: 'Broken · ACP stream closed · exit 137', tone: 'bad' } });
        expect(broken).toMatch(/data-chat-error[^>]*>[^<]*(<[^>]*>[^<]*)*ACP stream closed · exit 137/);
        expect(render(base)).not.toContain('data-chat-error');
    });
});
