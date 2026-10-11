import { describe, expect, it } from 'vitest';
import type { ListItem } from '../src/core/attention.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { HUMAN } from '../src/core/inbox.js';
import { deckBand } from '../src/core/deck.js';
import type { Finished, PendingQuestion } from '../src/main/attention-store.js';
import type { InboxMessage } from '../src/main/inbox-store.js';

/**
 * THE DECK'S FOUR SOURCES (§4.5) normalise into one item each, so the band ranks them as a whole.
 * Approvals already arrive from the session layer; the other three come from the stores built
 * tonight: agent questions, user-list items, unread DMs to the human, finished-with-handoff.
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

const finished = (over: Partial<Finished> = {}): Finished => ({
    id: 'fin_1',
    agentId: 'agent_a' as Finished['agentId'],
    agentName: 'atlas',
    handoff: 'PR #15 is up; the front door is next.',
    at: '2026-10-11T06:00:00.000Z',
    seen: false,
    ...over,
});

const names = { agent_a: { name: 'atlas', workspaceId: 'tynn' } };

describe('agent questions', () => {
    it('a single question with plain options answers INLINE; multi-part, multi-select or free-text-only expands into a FORM', () => {
        const [single] = deckItemsFrom({ questions: [question()], userList: [], unreadDms: [], finished: [], agents: names });
        expect(single).toMatchObject({ source: 'agent-question', agentId: 'agent_a', agentName: 'atlas', workspaceId: 'tynn', blocking: true, priority: 'normal', title: 'Which engine?', forwardedFrom: null });
        expect(single!.answer).toEqual({ kind: 'inline', options: [{ id: 'a', label: 'a', tone: 'neutral' }, { id: 'b', label: 'b', tone: 'neutral' }] });
        expect(single!.at).toBe(Date.parse('2026-10-11T05:00:00.000Z'));

        const [multi] = deckItemsFrom({ questions: [question({ questions: [question().questions[0]!, { header: 'Where', question: 'Where?', options: [{ label: 'x' }, { label: 'y' }] }] })], userList: [], unreadDms: [], finished: [], agents: names });
        expect(multi!.answer).toEqual({ kind: 'form', fields: 2 });
        expect(multi!.title).toBe('Which engine? (+1 more)');

        const [select] = deckItemsFrom({ questions: [question({ questions: [{ ...question().questions[0]!, multiSelect: true }] })], userList: [], unreadDms: [], finished: [], agents: names });
        expect(select!.answer).toEqual({ kind: 'form', fields: 1 });
    });

    it('an urgent question outranks a normal one; a question is BLOCKING — the agent has stopped', () => {
        const items = deckItemsFrom({ questions: [question({ id: 'q_n' }), question({ id: 'q_u', priority: 'urgent', askedAt: '2026-10-11T05:01:00.000Z' })], userList: [], unreadDms: [], finished: [], agents: names });
        expect(deckBand(items).map((i) => i.id)).toEqual(['q_u', 'q_n']);
        expect(items.every((i) => i.blocking)).toBe(true);
    });
});

describe('user-list items', () => {
    it('are things only a person can do: not blocking, normal priority, showing who asked, done inline', () => {
        const [item] = deckItemsFrom({ questions: [], userList: [{ workspaceId: 'tynn', item: listItem('rotate the GitHub token') }], unreadDms: [], finished: [], agents: names });
        expect(item).toMatchObject({ source: 'user-list', blocking: false, priority: 'normal', title: 'rotate the GitHub token', agentName: 'atlas', workspaceId: 'tynn' });
        expect(item!.answer).toEqual({ kind: 'inline', options: [{ id: 'done', label: 'Done', tone: 'neutral' }] });
        expect(item!.at).toBe(Date.parse('2026-10-11T04:00:00.000Z'));
    });

    it('a DONE item is not on the Deck', () => {
        expect(deckItemsFrom({ questions: [], userList: [{ workspaceId: 'tynn', item: { ...listItem('x'), done: true } }], unreadDms: [], finished: [], agents: names })).toEqual([]);
    });
});

describe('unread DMs to the human', () => {
    it('one item per unread message FROM an agent, titled with the first line, marked read inline', () => {
        const [item] = deckItemsFrom({ questions: [], userList: [], unreadDms: [dm({ text: 'Notes ready.\nSecond line.' })], finished: [], agents: names });
        expect(item).toMatchObject({ source: 'unread-dm', agentId: 'agent_a', agentName: 'atlas', blocking: false, priority: 'low', title: 'atlas: Notes ready.' });
        expect(item!.answer).toEqual({ kind: 'inline', options: [{ id: 'read', label: 'Mark read', tone: 'neutral' }] });
    });

    it('a message the human already read, or one from the human, is not an item — COUNTED', () => {
        const items = deckItemsFrom({ questions: [], userList: [], unreadDms: [dm({ readAt: '2026-10-11T05:31:00.000Z' }), dm({ id: 'msg_2', from: HUMAN, to: 'agent_a' as InboxMessage['to'] })], finished: [], agents: names });
        expect(items).toHaveLength(0);
    });
});

describe('finished with a handoff', () => {
    it('an unseen finish is an item carrying the handoff, with Open / Restart with this / mark read', () => {
        const [item] = deckItemsFrom({ questions: [], userList: [], unreadDms: [], finished: [finished()], agents: names });
        expect(item).toMatchObject({ source: 'finished-handoff', agentId: 'agent_a', agentName: 'atlas', workspaceId: 'tynn', blocking: false, priority: 'normal', title: 'atlas finished: PR #15 is up; the front door is next.' });
        expect(item!.answer).toEqual({ kind: 'inline', options: [{ id: 'open', label: 'Open', tone: 'neutral' }, { id: 'restart', label: 'Restart with this', tone: 'neutral' }, { id: 'seen', label: 'mark read', tone: 'neutral' }] });
    });

    it('a seen finish, or one with no handoff, is not an item — a finish with nothing to say is the agent’s row going idle, not a Deck row', () => {
        expect(deckItemsFrom({ questions: [], userList: [], unreadDms: [], finished: [finished({ seen: true }), finished({ id: 'fin_2', handoff: null })], agents: names })).toEqual([]);
    });
});

describe('the whole band', () => {
    it('all four sources rank together: blocking first, then priority, then oldest', () => {
        const items = deckItemsFrom({
            questions: [question()],
            userList: [{ workspaceId: 'tynn', item: listItem('rotate') }],
            unreadDms: [dm()],
            finished: [finished()],
            agents: names,
        });
        expect(deckBand(items).map((i) => i.source)).toEqual(['agent-question', 'user-list', 'finished-handoff', 'unread-dm']);
    });

    it('an agent the roster no longer knows still shows, with its id as the name — never dropped silently', () => {
        const [item] = deckItemsFrom({ questions: [], userList: [], unreadDms: [dm({ from: 'agent_gone' as InboxMessage['from'] })], finished: [], agents: names });
        expect(item).toMatchObject({ agentId: 'agent_gone', agentName: 'agent_gone', workspaceId: null });
    });
});
