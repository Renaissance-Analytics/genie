import { describe, expect, it } from 'vitest';
import type { ListItem } from '../src/core/attention.js';
import { deckItemsFrom, type DeckSourceInput } from '../src/core/deck-sources.js';
import { HUMAN } from '../src/core/inbox.js';
import type { PendingQuestion } from '../src/main/attention-store.js';
import type { InboxMessage } from '../src/main/inbox-store.js';

/**
 * THE DECK IS DERIVED INCREMENTALLY (Tynn #663). Window main builds the Deck on every snapshot, up to 20 a second; at the
 * owner's scale (240 open questions) rebuilding every item each time allocated about 3 GB per 5 minutes of garbage in
 * `deckItemsFrom` alone (the #662 soak's sampling profile). The stores never change a question, a list item or a message
 * in place — they replace it — so an item whose source object and whose surroundings (its workspace's name and colour,
 * its agent's name, whether its agent still waits) are unchanged is the SAME item as last time, and is not built again.
 *
 * Each test reads the source objects through counting getters: a rebuild reads them, a reuse does not. The first call is
 * the positive control (it must read them), so "0 reads" on the second call cannot pass by a getter that never counts.
 */

const reads = { questions: 0, text: 0, listText: 0 };

const question = (id: string, over: Partial<PendingQuestion> = {}): PendingQuestion => {
    const qs = [{ header: 'Engine', question: `Which engine for ${id}?\nSecond line.`, options: [{ label: 'a' }, { label: 'b' }] }];
    const q = {
        id,
        key: `k_${id}`,
        agentId: 'agent_a' as PendingQuestion['agentId'],
        agentName: 'atlas',
        workspaceId: 'tynn',
        priority: 'normal' as const,
        askedAt: '2026-10-11T05:00:00.000Z',
        ...over,
    };
    return Object.defineProperty(q, 'questions', { enumerable: true, get: () => { reads.questions += 1; return over.questions ?? qs; } }) as unknown as PendingQuestion;
};

const listItem = (text: string): ListItem => {
    const item = { id: `li_${text}`, askedBy: 'agent_a', createdAt: '2026-10-11T04:00:00.000Z', done: false };
    return Object.defineProperty(item, 'text', { enumerable: true, get: () => { reads.listText += 1; return text; } }) as unknown as ListItem;
};

const dm = (id: string, text: string): InboxMessage => {
    const m = { seq: 1, id, from: 'agent_a' as InboxMessage['from'], to: HUMAN, attachments: [], sentAt: '2026-10-11T05:30:00.000Z', readAt: null };
    return Object.defineProperty(m, 'text', { enumerable: true, get: () => { reads.text += 1; return text; } }) as unknown as InboxMessage;
};

const reset = () => { reads.questions = 0; reads.text = 0; reads.listText = 0; };

// Every snapshot builds these records afresh (deck-assembly.ts: Object.fromEntries per call), so the tests do too: reuse
// must key on what they SAY, never on their identity.
const input = (questions: readonly PendingQuestion[], over: Partial<DeckSourceInput> = {}): DeckSourceInput => ({
    questions,
    userList: [],
    unreadDms: [],
    agents: { agent_a: { name: 'atlas', workspaceId: 'tynn' } },
    workspaceNames: { tynn: 'Tynn.ai' },
    workspaceColors: { tynn: '#0af' },
    asker: () => ({ running: true, startedAt: 0 }),
    ...over,
});

describe('deckItemsFrom reuses what did not change (Tynn #663)', () => {
    it('the same questions, asked again with fresh but equal surroundings: the same items, and no question read again', () => {
        const qs = Array.from({ length: 240 }, (_, i) => question(`q_${i}`));
        reset();
        const first = deckItemsFrom(input(qs));
        // Positive control: building reads every question.
        expect(reads.questions).toBeGreaterThanOrEqual(240);
        reset();
        const second = deckItemsFrom(input([...qs]));
        expect(second).toHaveLength(240);
        second.forEach((item, i) => expect(item).toBe(first[i]));
        expect(reads.questions).toBe(0);
    });

    it('one question replaced: only its item is built again, and it says the new content', () => {
        const qs = [question('q_a'), question('q_b'), question('q_c')];
        const first = deckItemsFrom(input(qs));
        const updated = question('q_b', { revision: 2, priority: 'urgent' });
        reset();
        const second = deckItemsFrom(input([qs[0]!, updated, qs[2]!]));
        expect(second[0]).toBe(first[0]);
        expect(second[2]).toBe(first[2]);
        expect(second[1]).not.toBe(first[1]);
        expect(second[1]).toMatchObject({ id: 'q_b', revision: 2, priority: 'urgent' });
        expect(reads.questions).toBeGreaterThan(0);
    });

    it('a workspace renamed or recoloured, or its agent no longer waiting: the item is built again and says so', () => {
        const q = question('q_a');
        const first = deckItemsFrom(input([q]))[0]!;
        const renamed = deckItemsFrom(input([q], { workspaceNames: { tynn: 'Tynn' } }))[0]!;
        expect(renamed).not.toBe(first);
        expect(renamed.workspaceName).toBe('Tynn');
        const recoloured = deckItemsFrom(input([q], { workspaceNames: { tynn: 'Tynn' }, workspaceColors: { tynn: '#f00' } }))[0]!;
        expect(recoloured).not.toBe(renamed);
        expect(recoloured.workspaceColor).toBe('#f00');
        const ended = deckItemsFrom(input([q], { workspaceNames: { tynn: 'Tynn' }, workspaceColors: { tynn: '#f00' }, asker: () => ({ running: false, startedAt: 0 }) }))[0]!;
        expect(ended).not.toBe(recoloured);
        expect(ended.stale).toBe('session-ended');
        const gone = deckItemsFrom(input([q], { agents: {}, workspaceNames: { tynn: 'Tynn' }, workspaceColors: { tynn: '#f00' }, asker: () => ({ running: false, startedAt: 0 }) }))[0]!;
        expect(gone.stale).toBe('agent-gone');
        // And back: liveness not known judges nothing, so the mark goes.
        const unknown = deckItemsFrom(input([q], { workspaceNames: { tynn: 'Tynn' }, workspaceColors: { tynn: '#f00' }, asker: () => undefined }))[0]!;
        expect(unknown.stale).toBeUndefined();
    });

    it('the person’s list and unread mail: reused while unchanged; a renamed sender or a new message is built again', () => {
        const li = listItem('rotate the token');
        const m1 = dm('msg_1', 'Notes ready.\nSecond line.');
        const m2 = dm('msg_2', 'Build is green.');
        const withSources = (over: Partial<DeckSourceInput> = {}) => input([], { userList: [{ workspaceId: 'tynn', item: li }], unreadDms: [m1, m2], ...over });
        reset();
        const first = deckItemsFrom(withSources());
        expect(reads.listText).toBeGreaterThan(0);
        expect(reads.text).toBeGreaterThan(0);
        reset();
        const second = deckItemsFrom(withSources());
        second.forEach((item, i) => expect(item).toBe(first[i]));
        expect(reads.listText).toBe(0);
        expect(reads.text).toBe(0);
        // The sender renamed: the list item names who asked, the mail's titles name who sent, so all are built again.
        const renamed = deckItemsFrom(withSources({ agents: { agent_a: { name: 'kai', workspaceId: 'tynn' } } }));
        expect(renamed[0]!.agentName).toBe('kai');
        expect(renamed[1]!.title).toBe('kai: Notes ready.');
        expect(renamed[2]!.title).toBe('kai: Build is green.');
        // A new message: only it is new.
        const m3 = dm('msg_3', 'One more.');
        const more = deckItemsFrom(withSources({ agents: { agent_a: { name: 'kai', workspaceId: 'tynn' } }, unreadDms: [m1, m2, m3] }));
        expect(more[1]).toBe(renamed[1]);
        expect(more[2]).toBe(renamed[2]);
        expect(more[3]!.title).toBe('kai: One more.');
    });

    it('a reused item is equal to one built from scratch: reuse never changes what the Deck says', () => {
        const qs = [question('q_a', { reaskedAt: '2026-10-11T06:00:00.000Z', asks: 1 }), question('q_b')];
        const first = deckItemsFrom(input(qs));
        const again = deckItemsFrom(input(qs));
        // Fresh objects with the same content: nothing to reuse, so they are built — and must equal the reused ones.
        const rebuilt = deckItemsFrom(input([question('q_a', { reaskedAt: '2026-10-11T06:00:00.000Z', asks: 1 }), question('q_b')]));
        expect(again).toEqual(rebuilt);
        expect(again[0]).toBe(first[0]);
        expect(rebuilt[0]).not.toBe(first[0]);
    });
});
