import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatSendFor, observedMail } from '../src/core/chat-view.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * AN OBSERVED AGENT'S CHAT IS ITS INBOX THREAD (§4.4: "the AgentInbox thread only"). A Take Over window reports no
 * replies, but its TUI has Genie's MCP: the mail you sent it, whether it has read each one, and the mail it sent you
 * are all known. The flyout showed none of it — the thread was always empty — and the composer sent through the
 * session path, which an observed agent does not have, so every message came back "Not delivered".
 */
describe('InboxStore: a participant\'s conversation, and when mail is read', () => {
    let dir: string;
    let store: InboxStore;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-obsmail-')); store = await InboxStore.open(dir); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('lists mail to or from the participant, oldest first, the newest N; mail between others is left out', async () => {
        await store.send({ from: 'human', to: 'agent_k' as never, text: 'one' });
        await store.send({ from: 'agent_k' as never, to: 'human', text: 'two' });
        await store.send({ from: 'agent_b' as never, to: 'agent_k' as never, text: 'between others' });
        await store.send({ from: 'human', to: 'agent_b' as never, text: 'three' });
        expect(store.involving('human', 10).map((m) => m.text)).toEqual(['one', 'two', 'three']);
        expect(store.involving('human', 2).map((m) => m.text)).toEqual(['two', 'three']);
    });

    it('tells listeners who read when a receive acknowledges mail — not on a send, not on an empty receive', async () => {
        const readers: string[] = [];
        store.onRead((who) => { readers.push(who); });
        await store.send({ from: 'human', to: 'agent_k' as never, text: 'read me' });
        expect(readers).toEqual([]);
        await store.receive({ participant: 'agent_b' as never });
        expect(readers).toEqual([]);
        await store.receive({ participant: 'agent_k' as never });
        expect(readers).toEqual(['agent_k']);
        expect(store.involving('human', 10)[0]!.readAt).not.toBeNull();
    });
});

describe('observedMail: the thread and the unread count', () => {
    const recent = [
        { id: 'm1', from: 'human', to: 'agent_k', text: 'look at the tests', sentAt: '2026-10-12T14:05:00.000Z', readAt: '2026-10-12T14:07:00.000Z' },
        { id: 'm2', from: 'agent_k', to: 'human', text: 'on it', sentAt: '2026-10-12T14:08:00.000Z', readAt: null },
        { id: 'm3', from: 'human', to: 'agent_k', text: 'and the docs', sentAt: '2026-10-12T14:09:00.000Z', readAt: null },
        { id: 'm4', from: 'human', to: 'agent_x', text: 'someone else', sentAt: '2026-10-12T14:10:00.000Z', readAt: null },
    ];

    it('mail uses the shared two-state card, oldest first; unread still counts its mail the human has not received', () => {
        expect(observedMail(recent, 'agent_k', 'kora')).toEqual({
            messages: [
                { id: 'm1', who: 'mail', from: 'you → kora', text: 'look at the tests', delivered: true, at: Date.parse('2026-10-12T14:05:00.000Z'), mailId: 'm1' },
                { id: 'm2', who: 'mail', from: 'kora → you', text: 'on it', delivered: false, at: Date.parse('2026-10-12T14:08:00.000Z'), mailId: 'm2' },
                { id: 'm3', who: 'mail', from: 'you → kora', text: 'and the docs', delivered: false, at: Date.parse('2026-10-12T14:09:00.000Z'), mailId: 'm3' },
            ],
            unread: 1,
        });
    });

    it('no mail is a measured nothing (unread 0); an inbox not read yet is null, never 0', () => {
        expect(observedMail([], 'agent_k', 'kora')).toEqual({ messages: [], unread: 0 });
        expect(observedMail(null, 'agent_k', 'kora')).toEqual({ messages: [], unread: null });
    });
});

describe('chatSendFor: where the composer sends', () => {
    it('an observed agent\'s mail goes to its inbox by full address; a declared agent is prompted', () => {
        expect(chatSendFor({ fidelity: 'observed', workspaceId: 'tynn', provider: 'claude', name: 'kora' })).toEqual({ kind: 'inbox', to: 'tynn:claude:kora' });
        expect(chatSendFor({ fidelity: 'declared', workspaceId: 'tynn', provider: 'claude', name: 'kai' })).toEqual({ kind: 'prompt' });
    });
});

describe('the flyout: your mail, read or not', () => {
    const render = (thread: ChatThread) =>
        renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} />);
    const sent = new Date(2026, 9, 12, 14, 5).getTime();
    const read = new Date(2026, 9, 12, 14, 7).getTime();

    it('shows waiting/delivered card receipts, with no separate read state', () => {
        const html = render({ agentId: 'agent_k', name: 'kora', fidelity: 'observed', unread: 1, messages: [
            { id: 'm1', who: 'mail', from: 'you → kora', text: 'look at the tests', delivered: true, at: sent, mailId: 'm1' },
            { id: 'm2', who: 'mail', from: 'kora → you', text: 'on it', delivered: false, at: sent, mailId: 'm2' },
            { id: 'm3', who: 'mail', from: 'you → kora', text: 'and the docs', delivered: false, at: sent, mailId: 'm3' },
        ] });
        expect(html).not.toContain('data-chat-read=');
        expect(html.match(/data-mail-receipt="delivered"/g)).toHaveLength(1);
        expect(html.match(/data-mail-receipt="waiting"/g)).toHaveLength(2);
        expect(html).toContain('data-chat-unread="1"');
    });

    it('a declared thread shows no read marker (positive control: the same message, a declared agent)', () => {
        const html = render({ agentId: 'kai', name: 'kai', fidelity: 'declared', unread: null, messages: [
            { id: 'm1', who: 'you', from: 'you', text: 'look at the tests', delivered: true, at: sent, read },
        ] });
        expect(html).not.toContain('data-chat-read');
    });
});
