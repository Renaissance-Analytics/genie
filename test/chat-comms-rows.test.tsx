import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { chatThreadFrom, type MailLike } from '../src/core/chat-view.js';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';

/**
 * WHAT THE AGENT SAID TO OTHER AGENTS, IN ITS THREAD (the board's flyout: `atlas → wren · drop challenges table from
 * migration`, an arrows icon, mono, between the messages). AgentInbox mail between the subject and another agent is a
 * one-line system row in the subject's chat, placed by when it was sent: you see the coordination that explains what
 * the agent did next. Mail with the person is not one of these (it is the conversation itself), and mail between two
 * other agents is not this agent's. No mail read yet is no rows — not a claim that nobody wrote.
 */
const T = 1_700_000_000_000;
const rowOf = (id: string, name: string): AgentRow => ({
    id, name, provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: null, ask: null, reason: null, fixes: [],
    step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const rows = [rowOf('a1', 'atlas'), rowOf('a2', 'wren'), rowOf('a3', 'vesper')];
const mail = (id: string, from: string, to: string, text: string, at: number): MailLike => ({ id, from, to, text, sentAt: new Date(at).toISOString(), readAt: null });
const detail = (comms: readonly MailLike[] | null | undefined): AgentDetail => ({
    agent: { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' },
    session: null, turns: 0, cost: null, refusal: null,
    rows: [
        { id: 'e1', event: { kind: 'message', speaker: 'you', peerName: null, text: 'Use the cache driver.' }, at: T },
        { id: 'e2', event: { kind: 'message', speaker: 'agent', peerName: null, text: 'ChallengeStore is committed.' }, at: T + 120_000 },
    ],
    ...(comms === undefined ? {} : { comms }),
});

describe('the thread', () => {
    it('the subject’s mail with another agent is a system row, in time order; the person’s mail and other agents’ mail are not', () => {
        const thread = chatThreadFrom(detail([
            mail('m1', 'a1', 'a2', 'drop challenges table from migration\nthe store replaces it', T + 60_000),
            mail('m2', 'human', 'a1', 'hello', T + 70_000),
            mail('m3', 'a2', 'a3', 'not about atlas', T + 80_000),
            mail('m4', 'a3', 'a1', 'review done', T + 180_000),
        ]), 'a1', rows, () => 0);
        expect(thread.messages.map((m) => [m.id, m.who, m.text])).toEqual([
            ['e1', 'you', 'Use the cache driver.'],
            ['m1', 'system', 'atlas → wren · drop challenges table from migration'],
            ['e2', 'agent', 'ChallengeStore is committed.'],
            ['m4', 'system', 'vesper → atlas · review done'],
        ]);
    });

    it('no mail read yet (absent or null) adds nothing (positive control: the same thread with mail has rows)', () => {
        expect(chatThreadFrom(detail(undefined), 'a1', rows, () => 0).messages.map((m) => m.id)).toEqual(['e1', 'e2']);
        expect(chatThreadFrom(detail(null), 'a1', rows, () => 0).messages.map((m) => m.id)).toEqual(['e1', 'e2']);
        expect(chatThreadFrom(detail([mail('m1', 'a1', 'a2', 'x', T + 1)]), 'a1', rows, () => 0).messages.some((m) => m.who === 'system')).toBe(true);
    });
});

describe('the row', () => {
    it('one mono line with the arrows icon — no bubble, no speaker line', () => {
        const thread = chatThreadFrom(detail([mail('m1', 'a1', 'a2', 'drop challenges table from migration', T + 60_000)]), 'a1', rows, () => 0);
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} pinned={false} contextTokens={200_000} onSend={() => {}} onTogglePin={() => {}} onClose={() => {}} onPickThread={() => {}} />);
        expect(html).toMatch(/data-chat-message="m1" data-who="system"[\s\S]*atlas → wren · drop challenges table from migration/);
        expect(html.match(/data-who="system"/g)).toHaveLength(1);
    });
});
