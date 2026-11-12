import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import * as chatView from '../src/core/chat-view.js';
import { chatThreadFrom, observedMail, type MailLike } from '../src/core/chat-view.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { mintAgentId } from '../src/core/identity.js';
import { ReminderBook } from '../src/core/inbox-reminders.js';
import { inboxNotices } from '../src/main/inbox-notices.js';
import type { InboxMessage } from '../src/main/inbox-store.js';
import type { AgentDetail } from '../src/renderer/bridge.js';

/*
 * AN ID IS NEVER SHOWN TO THE PERSON (Tynn #621; the owner's screenshot, beta.61): a mail row in the tynn agent's chat read
 * "agent_a25f60800ff55c975eef6a4d7a6f826c → tynn · AgentInbox" for a message from genie, the OS agent. The chat named a
 * sender from the workspace agents' rows, which Genie's own agent is not in, and fell back to the raw id. A sender is
 * named; one that cannot be named gets words.
 */
const ID = /agent_[0-9a-f]{8,}/;
const OS = 'agent_a25f60800ff55c975eef6a4d7a6f826c';
const GONE = 'agent_0123456789abcdef0123456789abcdef';
const T = 1_700_000_000_000;
const rowOf = (id: string, name: string): AgentRow => ({
    id, name, provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: null, ask: null, reason: null, fixes: [],
    step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const rows = [rowOf('a1', 'tynn')];
const mail = (id: string, from: string, to: string, text: string): MailLike => ({ id, from, to, text, sentAt: new Date(T).toISOString(), readAt: null });
const detail = (comms: readonly MailLike[]): AgentDetail => ({
    agent: { id: 'a1', name: 'tynn', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' },
    session: null, turns: 0, cost: null, refusal: null, rows: [], comms,
} as AgentDetail);
/** Reached loosely so a missing second argument is red by assertion, not by a type error. */
const commsOf = chatView.chatCommsOf as unknown as (messages: readonly MailLike[], nameOf?: (id: string) => string | null) => MailLike[];
const nameOf = (id: string): string | null => (id === OS ? 'genie' : id === 'a1' ? 'tynn' : null);
const TEXT = 'genie here, writing for the person. Your current turn is Parked · waiting for you…';

describe('the mail row in an agent\'s chat', () => {
    it('mail from Genie\'s own agent, which is not among the workspace\'s rows, reads "genie → tynn"', () => {
        const thread = chatThreadFrom(detail(commsOf([mail('m1', OS, 'a1', TEXT)], nameOf)), 'a1', rows, () => 0);
        expect(thread.messages.map((m) => m.from)).toEqual(['genie → tynn']);
    });

    it('mail the agent sent to it reads "tynn → genie"', () => {
        const thread = chatThreadFrom(detail(commsOf([mail('m1', 'a1', OS, 'on it')], nameOf)), 'a1', rows, () => 0);
        expect(thread.messages.map((m) => m.from)).toEqual(['tynn → genie']);
    });

    it('a sender nobody can name gets words, never its id', () => {
        const thread = chatThreadFrom(detail(commsOf([mail('m1', GONE, 'a1', 'hello')], nameOf)), 'a1', rows, () => 0);
        expect(thread.messages[0]!.from).not.toMatch(ID);
        expect(thread.messages[0]!.from).toBe('an agent no longer in Genie → tynn');
    });

    it('an agent among the rows is still named from them (CONTROL)', () => {
        const both = [...rows, rowOf('a2', 'wren')];
        expect(chatThreadFrom(detail([mail('m1', 'a2', 'a1', 'review done')]), 'a1', both, () => 0).messages[0]!.from).toBe('wren → tynn');
    });

    it('an observed agent\'s inbox thread names no id either', () => {
        const seen = observedMail([mail('m1', GONE, 'a1', 'hello')], 'a1', 'tynn', rows);
        expect(seen.messages[0]!.from).not.toMatch(ID);
    });
});

describe('the other places a sender is named', () => {
    it('a delivered mail\'s fromName, as the agent is told it, is words for a sender not in the registry', () => {
        const recipient = mintAgentId();
        const unknown = mintAgentId();
        const message: InboxMessage = { seq: 1, id: 'msg_1', from: unknown, to: recipient, text: 'hello', sentAt: '2026-11-07T06:00:00.000Z', readAt: null, attachments: [] };
        const [batch] = inboxNotices({ agents: new Map([[recipient, { name: 'tynn' }]]), unread: (id) => (id === recipient ? [message] : []), reminders: new ReminderBook(), run: (id) => (id === recipient ? 1 : null) });
        const told = JSON.parse(batch!.text.slice(batch!.text.indexOf('\n') + 1)) as Array<{ from: string; fromName: string }>;
        expect(told[0]!.fromName).toBe('an agent no longer in Genie');
        // The id itself still travels for the agent to answer with (CONTROL).
        expect(told[0]!.from).toBe(unknown);
    });

    it('a Deck item from an agent the Deck cannot name carries words as its name', () => {
        const items = deckItemsFrom({
            questions: [], userList: [],
            unreadDms: [{ seq: 1, id: 'msg_1', from: GONE, to: 'human', text: 'hello', sentAt: new Date(T).toISOString(), readAt: null, attachments: [] }], agents: {},
        } as never);
        expect(items).toHaveLength(1);
        expect(items[0]!.agentName).toBe('an agent no longer in Genie');
        expect(items[0]!.title).not.toMatch(ID);
    });
});

describe('the wiring', () => {
    const src = (path: string) => readFileSync(path, 'utf8');

    it('the chat is given Genie\'s own agent beside the workspace agents', () => {
        expect(src('src/renderer/App.tsx')).toMatch(/const chatAgents = useMemo\(\(\) => \(snapshot\.osAgent \? \[\.\.\.snapshot\.agents, snapshot\.osAgent\] : snapshot\.agents\)/);
    });

    it('main names both ends of an agent\'s mail from the registry, Genie\'s own agent included', () => {
        expect(src('src/main/agent-detail.ts')).toMatch(/chatCommsOf\(ports\.mail\(record\.id, 50\), /);
    });

    it('no name in the inbox, the Deck or a notice falls back to an id', () => {
        expect(src('src/main/feature-ipc.ts')).not.toMatch(/\?\.name \?\? participant\)/);
        expect(src('src/renderer/components/InboxFlyout.tsx')).not.toMatch(/\?\.name \?\? id\)/);
        expect(src('src/main/inbox-notices.ts')).not.toMatch(/\?\.name \?\? m\.from/);
        expect(src('src/core/deck-sources.ts')).not.toMatch(/a\?\.name \?\? agentId/);
    });
});
