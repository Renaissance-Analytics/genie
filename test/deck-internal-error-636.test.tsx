import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem, SignalState } from '../src/core/deck.js';
import { MainErrorBook } from '../src/core/main-errors.js';
import { answerDeck, type DeckAnswerPorts } from '../src/main/deck-answer.js';
import { Deck } from '../src/renderer/components/Deck.js';

// Coverage added after the core implementation: prove it with an explicit mutation/restore on the test VM.
// Render the real Deck and dispatch through the real resolver/answerer; native OS opening is not exercised here.
const NOW = Date.parse('2026-11-13T05:00:00Z');
const TITLE = 'Genie recovered from an internal error.';
const DETAIL = 'Genie kept running, but an operation may not have finished.';
const FRAME = 'at syntheticPrivateOperation (file:///synthetic/internal.js:12:3)';
const QUIET = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false } as SignalState;
const kinds = ['uncaught-exception', 'unhandled-rejection'] as const;
const filed = (kind: typeof kinds[number] = 'unhandled-rejection') => {
    const book = new MainErrorBook({ now: () => NOW });
    const error = new Error('the connection closed: synthetic diagnostic');
    error.stack = `Error: ${error.message}\n    ${FRAME}`;
    book.record(kind, error);
    return { book, item: book.deckItems()[0]! };
};
const draw = (item: DeckItem, expanded = false) => renderToStaticMarkup(
    <Deck items={[item]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}}
        onNavigate={() => {}} onAnswerForm={() => {}} now={NOW} initiallyExpanded={expanded ? [item.id] : []} />,
);
const count = (html: string, text: string) => html.split(text).length - 1;
const ports = (mainErrors: DeckAnswerPorts['mainErrors']) => ({ mainErrors } as unknown as DeckAnswerPorts);
const answer = (item: DeckItem, optionId: string, mainErrors: DeckAnswerPorts['mainErrors']) =>
    answerDeck({ kind: 'deck.answer', item, optionId }, ports(mainErrors));

describe('internal-error Deck rendering and action dispatch (#636)', () => {
    it.each(kinds)('%s closed: one plain title, folded explanation, and three usable actions', (kind) => {
        const html = draw(filed(kind).item);
        expect(count(html, TITLE)).toBe(1);
        expect(html).toContain('Show all');
        expect(html).not.toContain(DETAIL);
        expect(html).not.toMatch(/synthetic diagnostic|syntheticPrivateOperation|internal\.js|file:\/\/\//);
        for (const id of ['open-log', 'report', 'dismiss']) {
            const button = html.match(new RegExp(`<button[^>]*data-approval-option="${id}"[^>]*>`))?.[0];
            expect(button).toBeDefined();
            expect(button).not.toMatch(/ disabled=""/);
        }
    });

    it.each(kinds)('%s opened: explanation once, title once, technical frames remain off screen', (kind) => {
        const html = draw(filed(kind).item, true);
        expect(count(html, TITLE)).toBe(1);
        expect(count(html, DETAIL)).toBe(1);
        expect(html).toContain('data-deck-detail=');
        expect(html).not.toMatch(/synthetic diagnostic|syntheticPrivateOperation|internal\.js|file:\/\/\//);
    });

    it('Report dispatches the exact internal item ID and says when the draft cannot open', async () => {
        const { item } = filed(); const seen: string[] = [];
        await answer(item, 'report', { dismiss: () => true, report: async (id) => { seen.push(id); return null; } });
        expect(seen).toEqual([item.id]);
        await expect(answer(item, 'report', { dismiss: () => true, report: async () => 'The draft could not be opened.' }))
            .rejects.toThrow('Genie could not open the issue draft: The draft could not be opened.');
    });

    it('Open log dispatches the exact internal item ID and returns an opening refusal', async () => {
        const { item } = filed(); const seen: (string | undefined)[] = [];
        await answer(item, 'open-log', { dismiss: () => true, openLog: async (id) => { seen.push(id); return null; } });
        expect(seen).toEqual([item.id]);
        await expect(answer(item, 'open-log', { dismiss: () => true, openLog: async () => 'The log could not be opened.' }))
            .rejects.toThrow('Genie could not open the log: The log could not be opened.');
    });

    it('missing native action ports explain where to act rather than pretending success', async () => {
        const { item } = filed();
        await expect(answer(item, 'report', { dismiss: () => true }))
            .rejects.toThrow('opening an issue draft needs Genie’s window on this machine: open Genie there');
        await expect(answer(item, 'open-log', { dismiss: () => true }))
            .rejects.toThrow('opening the log needs Genie’s window on this machine: open Genie there');
    });

    it('CONTROL: Dismiss reaches the actual book and removes only the selected error', async () => {
        const { book, item } = filed(); book.record('uncaught-exception', new Error('another synthetic error'));
        await answer(item, 'dismiss', book);
        expect(book.deckItems()).toHaveLength(1);
        expect(book.deckItems()[0]!.id).not.toBe(item.id);
    });

    it('CONTROL: lifecycle items still open the default log without an internal item ID', async () => {
        const book = new MainErrorBook({ now: () => NOW }); book.record('agent-host', new Error('synthetic host restart'));
        const seen: (string | undefined)[] = [];
        await answer(book.deckItems()[0]!, 'open-log', { dismiss: () => true, openLog: async (id) => { seen.push(id); return null; } });
        expect(seen).toEqual([undefined]);
    });

    it('CONTROL: a host-copy item retains its own title and folded diagnostic', () => {
        const book = new MainErrorBook({ now: () => NOW }); book.record('host-copy', new Error('SYNTHETIC-COPY-FAILURE'));
        const item = book.deckItems()[0]!;
        expect(draw(item)).not.toContain('SYNTHETIC-COPY-FAILURE');
        expect(count(draw(item, true), 'SYNTHETIC-COPY-FAILURE')).toBe(1);
        expect(draw(item, true)).not.toContain(TITLE);
    });
});
