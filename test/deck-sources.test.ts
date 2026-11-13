import { describe, expect, it } from 'vitest';
import type { ListItem } from '../src/core/attention.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { HUMAN } from '../src/core/inbox.js';
import { deckBand } from '../src/core/deck.js';
import type { PendingQuestion } from '../src/main/attention-store.js';
import type { InboxMessage } from '../src/main/inbox-store.js';

/**
 * THE DECK'S SOURCES (§4.5) normalise into one item each, so the band ranks them as a whole.
 * Approvals already arrive from the session layer; the rest come from the stores: agent questions,
 * user-list items, unread DMs to the human. A finished agent's handoff is not one of them: it is for
 * agents, never an item waiting for the person (Tynn #658; test/handoffs-for-agents.test.ts).
 */

const question = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({
    id: 'q_1',
    key: 'k',
    agentId: 'agent_a' as PendingQuestion['agentId'],
    agentName: 'atlas',
    workspaceId: 'tynn',
    questions: [{ header: 'Engine', question: 'Which engine?', options: [{ label: 'a' }, { label: 'b' }] }],
    priority: 'normal',
    askedAt: '2026-10-11T05:00:00.000Z',
    ...over,
});

const listItem = (text: string): ListItem => ({ id: `li_${text}`, text, askedBy: 'agent_a', createdAt: '2026-10-11T04:00:00.000Z', done: false });

const dm = (over: Partial<InboxMessage> = {}): InboxMessage => ({
    seq: 1,
    id: 'msg_1',
    from: 'agent_a' as InboxMessage['from'],
    to: HUMAN,
    text: 'The release notes are ready for your eyes.',
    attachments: [],
    sentAt: '2026-10-11T05:30:00.000Z',
    readAt: null,
    ...over,
});

const names = { agent_a: { name: 'atlas', workspaceId: 'tynn' } };

describe('agent questions', () => {
    // EVERY agent question is a form (the owner, 2026-10-14): ForceTheQuestion opens its window, and every question has its own note.
    it('every agent question is a FORM carrying its questions — a single plain one too; multi-part and multi-select as before', () => {
        const [single] = deckItemsFrom({ questions: [question()], userList: [], unreadDms: [], agents: names });
        expect(single).toMatchObject({ source: 'agent-question', agentId: 'agent_a', agentName: 'atlas', workspaceId: 'tynn', blocking: true, priority: 'normal', title: 'Engine', forwardedFrom: null });
        expect(single!.answer).toEqual({ kind: 'form', fields: 1, questions: [question().questions[0]!] });
        expect(single!.at).toBe(Date.parse('2026-10-11T05:00:00.000Z'));

        const [multi] = deckItemsFrom({ questions: [question({ questions: [question().questions[0]!, { header: 'Where', question: 'Where?', options: [{ label: 'x' }, { label: 'y' }] }] })], userList: [], unreadDms: [], agents: names });
        // The item CARRIES its questions, so the Deck can draw the form where the item is read (§4.5).
        expect(multi!.answer).toEqual({ kind: 'form', fields: 2, questions: [question().questions[0]!, { header: 'Where', question: 'Where?', options: [{ label: 'x' }, { label: 'y' }] }] });
        // Titled by the HEADER (the owner, 2026-10-15: the question as a title was unreadable) — the question is the body.
        expect(multi!.title).toBe('Engine + 1 more');

        const [select] = deckItemsFrom({ questions: [question({ questions: [{ ...question().questions[0]!, multiSelect: true }] })], userList: [], unreadDms: [], agents: names });
        expect(select!.answer).toEqual({ kind: 'form', fields: 1, questions: [{ ...question().questions[0]!, multiSelect: true }] });
    });

    it('an urgent question outranks a normal one; a question is BLOCKING — the agent has stopped', () => {
        const items = deckItemsFrom({ questions: [question({ id: 'q_n' }), question({ id: 'q_u', priority: 'urgent', askedAt: '2026-10-11T05:01:00.000Z' })], userList: [], unreadDms: [], agents: names });
        expect(deckBand(items).map((i) => i.id)).toEqual(['q_u', 'q_n']);
        expect(items.every((i) => i.blocking)).toBe(true);
    });
});

describe('user-list items', () => {
    it('are things only a person can do: not blocking, normal priority, showing who asked, done inline', () => {
        const [item] = deckItemsFrom({ questions: [], userList: [{ workspaceId: 'tynn', item: listItem('rotate the GitHub token') }], unreadDms: [], agents: names });
        expect(item).toMatchObject({ source: 'user-list', blocking: false, priority: 'normal', title: 'rotate the GitHub token', agentName: 'atlas', workspaceId: 'tynn' });
        expect(item!.answer).toEqual({ kind: 'inline', options: [{ id: 'done', label: 'Done', tone: 'neutral' }] });
        expect(item!.at).toBe(Date.parse('2026-10-11T04:00:00.000Z'));
    });

    it('a DONE item is not on the Deck', () => {
        expect(deckItemsFrom({ questions: [], userList: [{ workspaceId: 'tynn', item: { ...listItem('x'), done: true } }], unreadDms: [], agents: names })).toEqual([]);
    });
});

describe('unread DMs to the human', () => {
    it('one item per unread message FROM an agent, titled with the first line, marked read inline', () => {
        const [item] = deckItemsFrom({ questions: [], userList: [], unreadDms: [dm({ text: 'Notes ready.\nSecond line.' })], agents: names });
        expect(item).toMatchObject({ source: 'unread-dm', agentId: 'agent_a', agentName: 'atlas', blocking: false, priority: 'low', title: 'atlas: Notes ready.' });
        expect(item!.answer).toEqual({ kind: 'inline', options: [{ id: 'read', label: 'Mark read', tone: 'neutral' }] });
    });

    it('a message the human already read, or one from the human, is not an item — COUNTED', () => {
        const items = deckItemsFrom({ questions: [], userList: [], unreadDms: [dm({ readAt: '2026-10-11T05:31:00.000Z' }), dm({ id: 'msg_2', from: HUMAN, to: 'agent_a' as InboxMessage['to'] })], agents: names });
        expect(items).toHaveLength(0);
    });
});

describe('the whole band', () => {
    it('the sources rank together: blocking first, then priority, then oldest', () => {
        const items = deckItemsFrom({
            questions: [question()],
            userList: [{ workspaceId: 'tynn', item: listItem('rotate') }],
            unreadDms: [dm()],
            agents: names,
        });
        expect(deckBand(items).map((i) => i.source)).toEqual(['agent-question', 'user-list', 'unread-dm']);
    });

    // Tynn #621 changed the name: words, never the id. The item still shows, and still carries its agent id for actions.
    it('an agent the roster no longer knows still shows, named in words — never dropped silently, never its id', () => {
        const [item] = deckItemsFrom({ questions: [], userList: [], unreadDms: [dm({ from: 'agent_gone' as InboxMessage['from'] })], agents: names });
        expect(item).toMatchObject({ agentId: 'agent_gone', agentName: 'an agent no longer in Genie', workspaceId: null });
    });
});
