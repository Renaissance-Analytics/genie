import { describe, expect, it } from 'vitest';
import { attentionItems, moveQueueFocus, type AttentionSources } from '../attention-queue';

/**
 * One queue for "what needs me", out of the surfaces that each own a piece of it.
 *
 * Today a human has to notice a glow on a rail and then guess which of twelve
 * flyouts explains it. Questions and UserList items are two surfaces for one
 * intention — being asked for something — and the Deck's whole claim is that you
 * can clear your morning without opening either.
 *
 * The decisions worth pinning are about ORDER and about HONESTY: what outranks
 * what, and what the queue refuses to say when a host did not tell it.
 */

const Q = (over: Partial<AttentionSources['questions'][number]> = {}) => ({
    id: 'q1',
    questions: [{ header: 'Migrate or dual-write?', question: 'body', options: [] }],
    index: 0,
    ...over,
});

const L = (over: Partial<AttentionSources['listItems'][number]> = {}) => ({
    id: 'l1',
    text: 'Rotate the GH token',
    ...over,
});

const sources = (over: Partial<AttentionSources> = {}): AttentionSources => ({
    questions: [],
    listItems: [],
    ...over,
});

describe('what lands in the queue', () => {
    it('is empty when nothing is waiting', () => {
        expect(attentionItems(sources())).toEqual([]);
    });

    it('takes the question header as the one-line title', () => {
        const [item] = attentionItems(sources({ questions: [Q()] }));
        expect(item.title).toBe('Migrate or dual-write?');
        expect(item.kind).toBe('question');
    });

    it('takes the text of a list item as its title', () => {
        const [item] = attentionItems(sources({ listItems: [L()] }));
        expect(item.title).toBe('Rotate the GH token');
        expect(item.kind).toBe('list-item');
    });

    it('keys are unique ACROSS kinds, even when the ids collide', () => {
        // A question and a list item are free to share an id — they come from
        // different tables. An unprefixed key would make one of them disappear
        // from a React list, silently.
        const items = attentionItems(sources({ questions: [Q({ id: 'x' })], listItems: [L({ id: 'x' })] }));
        expect(new Set(items.map((i) => i.key)).size).toBe(2);
    });

    it('keeps a DEFERRED question, and says why it is deferred', () => {
        // Deferred means "not on the modal right now" — which is exactly the case
        // the at-rest surface exists for. Dropping it would hide the only thing
        // still waiting, and the host already distinguishes the reasons so the row
        // can say the true one instead of calling every deferral a DND.
        const [item] = attentionItems(
            sources({ questions: [Q({ deferred: true, deferralReason: 'unshowable' })] }),
        );
        expect(item.deferralReason).toBe('unshowable');
        expect(item.blocking).toBe(true);
    });
});

describe('blocking', () => {
    it('marks a question blocking and a list item not', () => {
        // Straight from the service's own words: ForceTheQuestion "parks the agent
        // on an answer, a UserList lets it carry on while a human does something".
        // So one has an agent stopped behind it and the other does not, and that is
        // the only distinction that should reorder a human's morning.
        const items = attentionItems(sources({ questions: [Q()], listItems: [L()] }));
        expect(items.find((i) => i.kind === 'question')!.blocking).toBe(true);
        expect(items.find((i) => i.kind === 'list-item')!.blocking).toBe(false);
    });
});

describe('order', () => {
    it('puts a blocking item ahead of a higher-priority non-blocking one', () => {
        // A blocked agent is burning nothing but it has STOPPED, and that is the
        // only state where the human is the bottleneck. A list item cannot
        // outrank it by being urgent.
        const items = attentionItems(
            sources({ questions: [Q({ id: 'q', priority: 'low' })], listItems: [L({ id: 'l' })] }),
        );
        expect(items.map((i) => i.kind)).toEqual(['question', 'list-item']);
    });

    it('orders by priority within the same blocking band', () => {
        const items = attentionItems(
            sources({
                questions: [
                    Q({ id: 'normal', priority: 'normal' }),
                    Q({ id: 'urgent', priority: 'urgent' }),
                    Q({ id: 'low', priority: 'low' }),
                    Q({ id: 'high', priority: 'high' }),
                ],
            }),
        );
        expect(items.map((i) => i.key)).toEqual([
            'question:urgent',
            'question:high',
            'question:normal',
            'question:low',
        ]);
    });

    it('treats a missing priority as normal', () => {
        const items = attentionItems(
            sources({ questions: [Q({ id: 'low', priority: 'low' }), Q({ id: 'bare' })] }),
        );
        expect(items.map((i) => i.key)).toEqual(['question:bare', 'question:low']);
    });

    it('puts the oldest first within equal priority', () => {
        const items = attentionItems(
            sources({
                questions: [
                    Q({ id: 'new', createdAt: 2_000 }),
                    Q({ id: 'old', createdAt: 1_000 }),
                ],
            }),
        );
        expect(items.map((i) => i.key)).toEqual(['question:old', 'question:new']);
    });

    it('does NOT let an unknown age jump the queue', () => {
        // A question forwarded by an older host has no createdAt. Treating absent
        // as 0 would make it the oldest thing on the board and float it to the top
        // of its band on the strength of a missing field.
        const items = attentionItems(
            sources({ questions: [Q({ id: 'known', createdAt: 5_000 }), Q({ id: 'unknown' })] }),
        );
        expect(items.map((i) => i.key)).toEqual(['question:known', 'question:unknown']);
    });

    it('does not protect a head the way the modal queue does', () => {
        // `insertByPriority` deliberately never displaces index 0, because that is
        // the question being answered right now and yanking it mid-answer is the
        // defect it exists to prevent. A status board has no such head, so reusing
        // that helper here would pin whichever row happened to arrive first.
        const items = attentionItems(
            sources({ questions: [Q({ id: 'first', priority: 'low' }), Q({ id: 'second', priority: 'urgent' })] }),
        );
        expect(items[0].key).toBe('question:second');
    });
});

describe('honesty', () => {
    it('reports an absent createdAt as null, never as a time', () => {
        // The host says so itself: absent "when it was forwarded from a host
        // running an older build, so render nothing rather than assuming a time".
        expect(attentionItems(sources({ questions: [Q()] }))[0].createdAt).toBeNull();
        expect(attentionItems(sources({ listItems: [L()] }))[0].createdAt).toBeNull();
    });

    it('reports a local question as having no remote host', () => {
        expect(attentionItems(sources({ questions: [Q()] }))[0].remoteHost).toBeNull();
    });

    it('carries the forwarding host through when there is one', () => {
        expect(attentionItems(sources({ questions: [Q({ remoteHost: 'studio' })] }))[0].remoteHost).toBe('studio');
    });

    it('names the agent that asked for a list item, and nothing when unknown', () => {
        // The agent matters because resolving the item NUDGES it. A row that cannot
        // say who asked must not invent one.
        expect(attentionItems(sources({ listItems: [L({ agentName: 'kai' })] }))[0].agentName).toBe('kai');
        expect(attentionItems(sources({ listItems: [L()] }))[0].agentName).toBeNull();
    });

    it('keeps the question body for markdown rendering, and has none for a list item', () => {
        expect(attentionItems(sources({ questions: [Q()] }))[0].body).toBe('body');
        expect(attentionItems(sources({ listItems: [L()] }))[0].body).toBeNull();
    });

    it('falls back to the question body when a question has no header', () => {
        const [item] = attentionItems(
            sources({ questions: [Q({ questions: [{ header: '', question: 'Just the body', options: [] }] })] }),
        );
        expect(item.title).toBe('Just the body');
    });

    it('survives a question with no sub-questions at all', () => {
        // Defensive: an empty `questions` array should not crash the whole board.
        const [item] = attentionItems(sources({ questions: [Q({ questions: [] })] }));
        expect(item.title).not.toBe('');
        expect(item.kind).toBe('question');
    });
});

/**
 * Naming the blocked agent.
 *
 * A question now carries the terminal of the agent parked on it. A row wants a
 * NAME, and only the caller knows the spec list that maps one to the other — so it
 * passes a resolver. The decisions worth pinning are both about refusing to guess.
 */
describe('agent attribution', () => {
    it('names the agent parked on a question', () => {
        const [item] = attentionItems(
            sources({ questions: [Q({ askerTerminalId: 't-kai' })] }),
            { agentNameFor: (id) => (id === 't-kai' ? 'kai' : null) },
        );
        expect(item.agentName).toBe('kai');
    });

    it('names nobody when no agent asked', () => {
        // An internal approval gate. The resolver is never consulted, because there
        // is nothing to consult it with — and falling back to "some agent in this
        // workspace" would blame one that is working fine.
        const calls: string[] = [];
        const [item] = attentionItems(sources({ questions: [Q()] }), {
            agentNameFor: (id) => {
                calls.push(id);
                return 'should-not-happen';
            },
        });
        expect(item.agentName).toBeNull();
        expect(calls).toEqual([]);
    });

    it('names nobody when the terminal no longer resolves', () => {
        // The agent was deleted, or the spec list is from a different workspace.
        // "We cannot name it" is the answer, not the raw terminal id — a row reading
        // "term-7f3a is blocked" tells a human nothing they can act on.
        const [item] = attentionItems(
            sources({ questions: [Q({ askerTerminalId: 't-gone' })] }),
            { agentNameFor: () => null },
        );
        expect(item.agentName).toBeNull();
    });

    it('names nobody when no resolver is given at all', () => {
        expect(attentionItems(sources({ questions: [Q({ askerTerminalId: 't-kai' })] }))[0].agentName).toBeNull();
    });

    it('still carries the terminal id, so a click can reveal the agent', () => {
        const [item] = attentionItems(sources({ questions: [Q({ askerTerminalId: 't-kai' })] }));
        expect(item.askerTerminalId).toBe('t-kai');
    });
})

describe('moveQueueFocus — J and K through the queue', () => {
    /**
     * The plan's keyboard model: *`J/K` queue*. `resolveShortcut` has resolved
     * `queue-move` since the shortcuts were restored and nothing acted on it, because there was
     * no focus to move — the band rendered rows and never said which one you were on.
     *
     * Pure, so the WRAPPING and the empty cases are checked without a DOM, which is where an
     * off-by-one in a list the human is about to approve things from would otherwise live.
     */
    const keys = ['question:q1', 'list:t1', 'question:q2'];
    const items = keys.map((key) => ({ key }) as never);

    it('starts at the TOP when nothing is focused and you press J', () => {
        // The first row is the most urgent — `attentionItems` ranks them — so entering the queue
        // from nowhere lands on the thing that matters most, not on row two.
        expect(moveQueueFocus(items, null, 1)).toBe('question:q1');
    });

    it('starts at the BOTTOM when nothing is focused and you press K', () => {
        expect(moveQueueFocus(items, null, -1)).toBe('question:q2');
    });

    it('moves down and up by one', () => {
        expect(moveQueueFocus(items, 'question:q1', 1)).toBe('list:t1');
        expect(moveQueueFocus(items, 'list:t1', -1)).toBe('question:q1');
    });

    it('STOPS at the ends rather than wrapping', () => {
        // Wrapping in a queue you are resolving is how you approve the wrong thing: you press J
        // once more than the list is long and the selection silently jumps back to the top,
        // which looks identical to not having moved.
        expect(moveQueueFocus(items, 'question:q2', 1)).toBe('question:q2');
        expect(moveQueueFocus(items, 'question:q1', -1)).toBe('question:q1');
    });

    it('re-enters from the top when the focused row has GONE', () => {
        // Rows disappear as agents answer and items resolve. A key that is no longer in the
        // list must not leave the focus nowhere — and must not silently pick whatever row took
        // its index, which would be a different item under the same cursor.
        expect(moveQueueFocus(items, 'question:vanished', 1)).toBe('question:q1');
    });

    it('answers null for an EMPTY queue', () => {
        expect(moveQueueFocus([], null, 1)).toBeNull();
        expect(moveQueueFocus([], 'question:q1', -1)).toBeNull();
    });
});
