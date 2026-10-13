import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Approval } from '../src/core/approval.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE CHAT'S OWN WORDS, AS THE BOARD WRITES THEM (`Chat Flyout.dc.html`). The composer names who you are writing to —
 * `Message atlas`, and while that agent waits on an approval, `Reply to wren, or answer with A / D` — instead of
 * "Message this agent". genie's empty thread says what genie is for (it can reach any agent in any workspace; name one
 * with @, or pick a thread above): genie is the one thread with no work of its own to show. Any other empty thread
 * still says nothing — no greeting attributed to an agent that did not send it.
 */
const thread = (over: Partial<ChatThread>): ChatThread => ({ agentId: 'a1', name: 'atlas', fidelity: 'declared', unread: null, messages: [], ...over });
const approval: Approval = { question: 'Run php artisan migrate --force?', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] };
const render = (t: ChatThread, a: Approval | null = null) =>
    renderToStaticMarkup(<ChatFlyout thread={t} pinned={false} contextTokens={200_000} approval={a} onSend={() => {}} onTogglePin={() => {}} onClose={() => {}} onPickThread={() => {}} />);

describe('the composer names who you are writing to', () => {
    it('Message <name>; with an approval parked, Reply to <name>, or answer with A / D', () => {
        expect(render(thread({}))).toContain('placeholder="Message atlas"');
        expect(render(thread({ name: 'wren' }), approval)).toContain('placeholder="Reply to wren, or answer with A / D"');
        expect(render(thread({}))).not.toContain('Message this agent');
    });
});

describe('an empty thread', () => {
    it('genie’s says what genie is for; another agent’s says nothing (positive control: same render, other agent)', () => {
        const genie = render(thread({ agentId: 'genie', name: 'genie' }));
        expect(genie).toContain('data-chat-empty="genie"');
        expect(genie).toContain('No messages with genie yet.');
        expect(genie).toContain('genie can reach any agent in any workspace. Name one with @, or pick a thread above.');
        const atlas = render(thread({}));
        expect(atlas).not.toContain('data-chat-empty');
        expect(atlas).not.toContain('No messages with');
    });

    it('genie’s thread with a message is not empty', () => {
        expect(render(thread({ agentId: 'genie', name: 'genie', messages: [{ id: 'm1', who: 'you', from: 'you', text: 'hi', delivered: true, at: null }] }))).not.toContain('data-chat-empty');
    });
});
