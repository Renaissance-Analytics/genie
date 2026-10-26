import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { withDrafts, type Draft } from '../src/core/chat-view.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * AN UNDELIVERED MESSAGE AFTER ITS AGENT IS RUNNING AGAIN (the owner, 2026-10-20, after beta.32: "this retarded shit is
 * stuck on my screen. it was the first message I sent you after the upgrade"). The agent was started another way (from
 * the Dashboard), and the draft stayed: below the newer messages, still saying "tynn is not running", still offering
 * "Restart tynn and send", with no way to put it away. Now it sits where it was written, says what is true now, offers
 * Send now when the agent runs, and can always be discarded.
 */
const wire = { agentId: 'a1', name: 'tynn', fidelity: 'declared' as const, unread: null, context: null, messages: [
    { id: 'e1', who: 'agent' as const, from: 'tynn', text: 'Starting with the tabs.', delivered: true, at: 1_000 },
    { id: 'e2', who: 'you' as const, from: 'you', text: 'one starts if I select it from the dashboard', delivered: true, at: 3_000 },
] };
const draft: Draft = { id: 'd1', agentId: 'a1', text: 'WTF happened to my agent tabs?', at: 2_000 };

describe('withDrafts', () => {
    it('a draft sits where it was written — before a LATER message, not after it', () => {
        expect(withDrafts(wire, [draft]).messages.map((m) => m.id)).toEqual(['e1', 'd1', 'e2']);
    });

    it('the agent running now: the draft is sent by Send now; not running: by Restart and send (CONTROL)', () => {
        expect(withDrafts(wire, [draft], { running: true }).messages.find((m) => m.id === 'd1')).toMatchObject({ delivered: false, resend: 'send' });
        expect(withDrafts(wire, [draft]).messages.find((m) => m.id === 'd1')).toMatchObject({ delivered: false, resend: 'restart' });
    });
});

const render = (t: ChatThread) => renderToStaticMarkup(<ChatFlyout thread={t} onSend={() => {}} onClose={() => {}} onRestartAndSend={() => {}} onDiscardDraft={() => {}} />);
const threadWith = (resend: 'send' | 'restart'): ChatThread => ({ ...wire, messages: [{ id: 'd1', who: 'you', from: 'you', text: draft.text, delivered: false, at: 2_000, resend }] });

describe('on screen', () => {
    it('running now: says it was not running WHEN SENT, offers Send now — and never claims it is not running', () => {
        const html = render(threadWith('send'));
        expect(html).toContain('Not delivered. tynn was not running when you sent it.');
        expect(html).not.toContain('tynn is not running');
        expect(html).toMatch(/<button[^>]*data-action="send-draft"[^>]*data-draft="d1"[^>]*>Send now<\/button>/);
        expect(html).not.toContain('data-action="restart"');
    });

    it('not running: the chat’s one Restart (genie#1238) (CONTROL)', () => {
        const html = render(threadWith('restart'));
        expect(html).toContain('Not delivered. tynn is not running.');
        expect(html).toMatch(/data-action="restart"[^>]*>Restart</);
    });

    it('either way it can be discarded', () => {
        for (const r of ['send', 'restart'] as const) expect(render(threadWith(r))).toMatch(/<button[^>]*data-action="discard-draft"[^>]*data-draft="d1"[^>]*>Discard<\/button>/);
    });
});
