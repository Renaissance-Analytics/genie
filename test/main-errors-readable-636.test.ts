import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { MainErrorBook, installMainErrorPolicy } from '../src/core/main-errors.js';
import { resolveDeckAnswer } from '../src/core/deck-resolve.js';

const FRAME = 'at HostRegistryStore.readAgents (file:///synthetic/genie-host.js:12:3)';
const kinds = ['uncaught-exception', 'unhandled-rejection'] as const;
function fault(message = 'the connection closed') {
    const error = new Error(message);
    error.stack = `Error: ${message}\n    ${FRAME}\n    at syntheticCaller (file:///synthetic/window.js:20:1)`;
    return error;
}
function item(kind: typeof kinds[number], message?: string) {
    const book = new MainErrorBook(); book.record(kind, fault(message));
    return book.deckItems()[0]!;
}

describe('internal failures are said plainly on the Deck (#636)', () => {
    it.each(kinds)('%s has one plain first sentence instead of a raw diagnostic title', (kind) => {
        expect(item(kind).title.split('\n')[0]).toBe('Genie recovered from an internal error.');
    });

    it.each(kinds)('%s has a folded explanation without a stack frame, even when the reason embeds one', (kind) => {
        const shown = item(kind, `the connection closed\n    ${FRAME}`);
        expect(shown.title).not.toContain(FRAME);
        expect(shown.detail).toBeTypeOf('string');
        expect(shown.detail!.trim().length).toBeGreaterThan(0);
        expect(shown.detail).not.toMatch(/HostRegistryStore|file:\/\/\/|\bat \w+\./);
    });

    it('both kinds offer Open the log, Report and Dismiss, with Report routed to a real action', () => {
        for (const kind of kinds) {
            const shown = item(kind);
            expect(shown.answer.kind).toBe('inline');
            if (shown.answer.kind !== 'inline') throw new Error('expected internal error controls');
            expect(shown.answer.options.map(({ id, label }) => `${id}=${label}`)).toEqual(['open-log=Open the log', 'report=Report', 'dismiss=Dismiss']);
            expect(resolveDeckAnswer(shown, 'report')).toEqual({ kind: 'report-main-error', id: shown.id });
        }
    });

    it('CONTROL: the full technical failure remains in the log while the process stays running', () => {
        const proc = new EventEmitter(); const book = new MainErrorBook(); const lines: string[] = [];
        installMainErrorPolicy(proc, book, (line) => { lines.push(line); });
        proc.emit('unhandledRejection', fault(), Promise.resolve());
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(FRAME);
        expect(lines[0]).toContain('the connection closed');
        expect(book.list()[0]!.stack).toContain(FRAME);
        expect(proc.listenerCount('unhandledRejection')).toBe(1);
    });

    it('CONTROL: repeats retain one counted item and Dismiss still removes it', () => {
        const book = new MainErrorBook(); book.record('uncaught-exception', fault()); book.record('uncaught-exception', fault());
        expect(book.deckItems()).toHaveLength(1);
        expect(book.list()[0]!.count).toBe(2);
        expect(book.dismiss(book.deckItems()[0]!.id)).toBe(true);
        expect(book.deckItems()).toEqual([]);
    });
});
