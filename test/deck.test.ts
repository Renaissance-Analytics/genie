import { describe, expect, it } from 'vitest';
import { PRIORITIES, deckBand, signalStrip, type DeckItem, type Signal } from '../src/core/deck.js';

/**
 * THE DECK — "does anything need me?"
 *
 * The attention queue, and **the only place badges exist**. If a badge appears anywhere else,
 * the design has failed.
 *
 * Its acceptance test is a sentence: *you can clear the entire band without navigating once.*
 * Everything here serves that — the ranking, so the top of the list is the thing most worth
 * doing; the inline/expand split, so a question is answered where it is read; and the refusal
 * to show a forwarded question as answerable here.
 */

const item = (over: Partial<DeckItem> = {}): DeckItem => ({
    id: 'i1',
    source: 'agent-question',
    agentId: 'kai',
    agentName: 'kai',
    workspaceId: 'tynn',
    title: 'Allow php artisan migrate --force?',
    blocking: true,
    priority: 'normal',
    at: 1_760_000_000_000,
    answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] },
    forwardedFrom: null,
    ...over,
});

describe('the ranking — blocking first, then priority, then oldest', () => {
    it('puts a BLOCKING item above a higher-priority one that is not', () => {
        /**
         * Blocking means an agent has stopped and is waiting. A high-priority note that blocks
         * nothing can be read in a minute; a blocked agent is doing nothing until somebody
         * answers, and every minute of that is wasted work.
         */
        const band = deckBand([
            item({ id: 'urgent-not-blocking', blocking: false, priority: 'urgent' }),
            item({ id: 'blocking-normal', blocking: true, priority: 'normal' }),
        ]);

        expect(band.map((i) => i.id)).toEqual(['blocking-normal', 'urgent-not-blocking']);
    });

    it('ranks by priority within the blocking group', () => {
        const band = deckBand([
            item({ id: 'low', priority: 'low' }),
            item({ id: 'urgent', priority: 'urgent' }),
            item({ id: 'normal', priority: 'normal' }),
            item({ id: 'high', priority: 'high' }),
        ]);

        expect(band.map((i) => i.id)).toEqual(['urgent', 'high', 'normal', 'low']);
    });

    it('breaks a tie with the OLDEST, because it has been waiting longest', () => {
        const band = deckBand([
            item({ id: 'newer', at: 2_000 }),
            item({ id: 'older', at: 1_000 }),
        ]);

        expect(band.map((i) => i.id)).toEqual(['older', 'newer']);
    });

    it('offers exactly the four priorities the design names', () => {
        expect(PRIORITIES).toEqual(['urgent', 'high', 'normal', 'low']);
    });

    it('is stable across the whole ordering, not just pairwise', () => {
        // A comparator can be right about every pair and wrong about the sequence. Six items
        // across both dimensions, asserted as one order.
        const band = deckBand([
            item({ id: 'a', blocking: false, priority: 'urgent', at: 5 }),
            item({ id: 'b', blocking: true, priority: 'low', at: 4 }),
            item({ id: 'c', blocking: true, priority: 'urgent', at: 3 }),
            item({ id: 'd', blocking: false, priority: 'low', at: 2 }),
            item({ id: 'e', blocking: true, priority: 'urgent', at: 1 }),
            item({ id: 'f', blocking: false, priority: 'urgent', at: 0 }),
        ]);

        expect(band.map((i) => i.id)).toEqual(['e', 'c', 'b', 'f', 'a', 'd']);
    });
});

describe('how an item is answered', () => {
    it('answers INLINE when answering inline is the whole answer', () => {
        expect(deckBand([item()])[0]?.answer).toMatchObject({ kind: 'inline' });
    });

    it('EXPANDS in place for a question with more than one part', () => {
        // *"A multi-part, multi-select or free-text question expands into a full form in
        // place."* In place, because navigating away is what the acceptance test forbids.
        const expanded = item({
            answer: { kind: 'form', fields: 2 },
        });
        expect(deckBand([expanded])[0]?.answer).toMatchObject({ kind: 'form' });
    });

    it('refuses to answer a FORWARDED question here, and says where it belongs', () => {
        /**
         * A question raised on another host must be answered on that host. Answering the local
         * copy marks it done while the real one waits forever — an agent blocked on a decision
         * somebody believes they already made.
         */
        const forwarded = deckBand([item({ forwardedFrom: 'alphar' })])[0];

        expect(forwarded?.answer).toMatchObject({ kind: 'elsewhere', host: 'alphar' });
    });

    it('keeps the item VISIBLE when it cannot be answered here', () => {
        // Hiding it would be worse: the agent is still blocked, and the only clue would be
        // gone from the one surface whose job is to show what needs a human.
        expect(deckBand([item({ forwardedFrom: 'alphar' })])).toHaveLength(1);
    });
});

describe('the signal strip — silent unless something is true', () => {
    it('emits nothing when nothing is true', () => {
        /**
         * *"A strip reading '0 waiting · no flows · GitHub fine' is furniture that trains
         * people to stop reading it."*
         */
        expect(signalStrip({ flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false }))
            .toEqual([]);
    });

    it('emits a signal only for a true condition', () => {
        const signals = signalStrip({
            flowsRunning: 2, uncollectedMail: 0, githubBlocked: true, osAgentWorking: false,
        });

        expect(signals.map((s) => s.kind)).toEqual(['flows', 'github']);
    });

    it('gives every signal a DOOR — a route to the feature it is about', () => {
        /**
         * *"Every signal is also a door."* A strip that announces a problem and offers no way
         * to it is a strip that makes somebody go looking, which is the opposite of what an
         * attention surface is for.
         */
        const signals = signalStrip({
            flowsRunning: 2, uncollectedMail: 5, githubBlocked: true, osAgentWorking: true,
        });

        expect(signals).toHaveLength(4);
        expect(signals.filter((s: Signal) => !s.route.startsWith('genie://'))).toEqual([]);
        // And each goes somewhere DIFFERENT; four doors to one room is one door.
        expect(new Set(signals.map((s) => s.route)).size).toBe(4);
    });

    it('never emits a count of zero inside a label', () => {
        // COUNT across every combination with a zero in it, rather than spot-checking one.
        const combos = [
            { flowsRunning: 0, uncollectedMail: 3, githubBlocked: false, osAgentWorking: false },
            { flowsRunning: 3, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
            { flowsRunning: 0, uncollectedMail: 0, githubBlocked: true, osAgentWorking: false },
        ];

        const withZero = combos.flatMap(signalStrip).filter((s) => /\b0\b/.test(s.label));
        expect(withZero).toEqual([]);

        // POSITIVE CONTROL: the labels do carry numbers when there are numbers to carry.
        expect(combos.flatMap(signalStrip).filter((s) => /\d/.test(s.label)).length).toBeGreaterThan(0);
    });
});
