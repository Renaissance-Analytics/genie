import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';
import { chatAction } from '../src/core/keys.js';

/**
 * THE FLYOUT RENDERS THE CONVERSATION THE BOARD DRAWS (`Chat Flyout.dc.html`): a context line under the thread
 * chips; messages as you (right-aligned, `you · 13:58`), the agent (its NAME in violet), a peer as `wren → atlas`;
 * chips for the workspace's agents with their state dot, the active one marked; Esc closes an UNPINNED flyout and
 * never a pinned one. Rendering `role` alone once labelled a sibling agent's message `user` — the same word as the
 * owner's — so the speaker is a field, not a guess.
 */

const T = 1_700_000_000_000;
const thread: ChatThread = {
    agentId: 'a1', name: 'atlas', fidelity: 'declared', unread: null,
    context: { text: 'Working · Plan 4/7 · Passkey enrolment endpoint', tone: 'ok' },
    chips: [
        { agentId: 'a1', name: 'atlas', state: 'working', fidelity: 'declared', active: true, unread: null },
        { agentId: 'a2', name: 'wren', state: 'waiting', fidelity: 'declared', active: false, unread: null },
    ],
    messages: [
        { id: 'm1', who: 'you', from: 'you', text: 'Use the cache driver.', delivered: true, at: T },
        { id: 'm2', who: 'agent', from: 'atlas', text: 'Moving challenges to the cache store.', delivered: true, at: T + 60_000 },
        { id: 'm3', who: 'peer', from: 'wren → atlas', text: 'drop the challenges table', delivered: true, at: null },
    ],
};
const render = (t: ChatThread, pinned = false) =>
    renderToStaticMarkup(<ChatFlyout thread={t} pinned={pinned} contextTokens={200_000} onSend={() => {}} onTogglePin={() => {}} onClose={() => {}} onPickThread={() => {}} />);

describe('the chat transcript', () => {
    it('renders every message with its speaker: you on the right, the agent by NAME, the peer as `peer → agent`', () => {
        const html = render(thread);
        expect((html.match(/data-chat-message="/g) ?? []).length).toBe(3);
        expect(html).toMatch(/data-chat-message="m1"[^>]*data-who="you"/);
        expect(html).toMatch(/data-chat-message="m2"[^>]*data-who="agent"/);
        expect(html).toMatch(/data-chat-message="m3"[^>]*data-who="peer"/);
        expect(html).toContain('wren → atlas');
        expect(html).toContain('Moving challenges to the cache store.');
        // The agent's name labels its message — never the word "user" or "assistant".
        expect(html).not.toMatch(/>\s*(user|assistant)\s*</);
    });

    it('shows a time only when the message had one — never a synthesised clock', () => {
        const html = render(thread);
        expect((html.match(/data-chat-time="/g) ?? []).length).toBe(2);
        expect(html).not.toMatch(/data-chat-message="m3"[^]*?data-chat-time=/);
    });

    it('the context line sits under the chips in its tone; absent when there is none', () => {
        expect(render(thread)).toMatch(/data-chat-context="ok"[^>]*>Working · Plan 4\/7 · Passkey enrolment endpoint/);
        expect(render({ ...thread, context: { text: 'Parked · waiting on you', tone: 'warn' } })).toContain('data-chat-context="warn"');
        expect(render({ ...thread, context: null })).not.toContain('data-chat-context');
    });

    it('thread chips: one per agent in the workspace, the subject active, clickable to switch the thread', () => {
        const html = render(thread);
        expect((html.match(/data-chat-thread-chip="/g) ?? []).length).toBe(2);
        expect(html).toMatch(/data-chat-thread-chip="a1"[^>]*data-active="true"/);
        expect(html).toMatch(/data-chat-thread-chip="a2"(?![^>]*data-active)/);
        // No chips row at all when there are none to show — not an empty strip.
        expect(render({ ...thread, chips: [] })).not.toContain('data-chat-threads');
    });
});

describe('Esc and the flyout', () => {
    it('closes an UNPINNED flyout, never a pinned one, and never while typing', () => {
        const esc = { key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
        expect(chatAction({ ...esc, typing: false }, { open: true, pinned: false })).toBe('close-chat');
        expect(chatAction({ ...esc, typing: false }, { open: true, pinned: true })).toBeNull();
        expect(chatAction({ ...esc, typing: true }, { open: true, pinned: false })).toBeNull();
        expect(chatAction({ ...esc, typing: false }, { open: false, pinned: false })).toBeNull();
        expect(chatAction({ ...esc, key: 'x', typing: false }, { open: true, pinned: false })).toBeNull();
    });
});
