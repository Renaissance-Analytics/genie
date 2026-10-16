import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { deckBand, needsYouCount } from '../src/core/deck.js';
import { deckAnswerRoute, resolveDeckAnswer } from '../src/core/deck-resolve.js';
import {
    MAIN_ERROR_DECK_PREFIX,
    MAIN_ERROR_OVERFLOW_ID,
    MainErrorBook,
    describeThrown,
    installMainErrorPolicy,
} from '../src/core/main-errors.js';

/**
 * THE MAIN PROCESS'S POLICY FOR AN ERROR NOBODY CAUGHT (the owner, 2026-10-15): log it with its stack, record it as a
 * recoverable problem the person sees on the Deck, keep running. A repeat is a count, not N items; the list is bounded
 * and what the bound replaced is itself on the Deck. Red on origin/main: there is no src/core/main-errors.ts, and no
 * listener — so Electron's blocking "A JavaScript error occurred in the main process" dialog is what an uncaught
 * error gets (measured: an EPIPE from the pty froze Genie behind it).
 *
 * The process is an EventEmitter stand-in, never vitest's own `process`: a test that installed real listeners on the
 * runner would change how the runner itself reports failures.
 */

/** An Error with a fixed stack, so its identity (message + top frame) is the test's choice, not the runner's. */
function thrown(message: string, frame = 'at PtyHost.write (file:///opt/genie/example/fancy-term-host.js:10:5)', code?: string): Error {
    const e = new Error(message);
    e.stack = `Error: ${message}\n    ${frame}\n    at Socket.emit (node:events:519:28)`;
    if (code !== undefined) Object.assign(e, { code });
    return e;
}

function installed(options: { now?: () => number; max?: number } = {}) {
    const proc = new EventEmitter();
    const book = new MainErrorBook(options);
    const lines: string[] = [];
    installMainErrorPolicy(proc, book, (line) => { lines.push(line); });
    return { proc, book, lines };
}

describe('the control: what Electron decides by', () => {
    it('no listener before the policy; exactly ONE uncaughtException and ONE unhandledRejection listener after — and a second install adds none', () => {
        // Electron shows its blocking main-process error dialog only when `uncaughtException` has no listener; Node turns an
        // unhandled rejection into an uncaught exception when `unhandledRejection` has none. So the counts ARE the behaviour.
        const proc = new EventEmitter();
        expect(proc.listenerCount('uncaughtException')).toBe(0);
        expect(proc.listenerCount('unhandledRejection')).toBe(0);
        const book = new MainErrorBook();
        installMainErrorPolicy(proc, book, () => {});
        expect(proc.listenerCount('uncaughtException')).toBe(1);
        expect(proc.listenerCount('unhandledRejection')).toBe(1);
        installMainErrorPolicy(proc, book, () => {});
        expect(proc.listenerCount('uncaughtException')).toBe(1);
        expect(proc.listenerCount('unhandledRejection')).toBe(1);
    });
});

describe('an uncaught exception and an unhandled rejection are recorded, logged, and visible', () => {
    it('an uncaught exception: one Deck item from Genie itself, Dismiss to put it aside, and the full stack in the log', () => {
        const { proc, book, lines } = installed({ now: () => 1_000 });
        proc.emit('uncaughtException', thrown('write EPIPE', undefined, 'EPIPE'), 'uncaughtException');
        const items = book.deckItems();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ source: 'genie', agentId: null, agentName: null, workspaceId: null, blocking: false, priority: 'high', at: 1_000, forwardedFrom: null });
        expect(items[0]!.id.startsWith(MAIN_ERROR_DECK_PREFIX)).toBe(true);
        expect(items[0]!.title).toBe('Genie kept running after an uncaught exception: write EPIPE (at PtyHost.write (file:///opt/genie/example/fancy-term-host.js:10:5)). The stack is in Genie’s log.');
        expect(items[0]!.answer).toEqual({ kind: 'inline', options: [{ id: 'dismiss', label: 'Dismiss', tone: 'neutral' }] });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('[genie] uncaught exception in the main process, recorded on the Deck; Genie keeps running: Error: write EPIPE');
        expect(lines[0]).toContain('at Socket.emit (node:events:519:28)');
    });

    it('an unhandled rejection: recorded under its own kind, even when the reason is not an Error', () => {
        const { proc, book, lines } = installed();
        proc.emit('unhandledRejection', 'connect ECONNREFUSED genie.example:443', Promise.resolve());
        expect(book.list()).toHaveLength(1);
        expect(book.list()[0]).toMatchObject({ kind: 'unhandled-rejection', message: 'connect ECONNREFUSED genie.example:443', topFrame: '', stack: null, count: 1 });
        expect(book.deckItems()[0]!.title).toBe('Genie kept running after an unhandled promise rejection: connect ECONNREFUSED genie.example:443. The stack is in Genie’s log.');
        expect(lines).toEqual(['[genie] unhandled promise rejection in the main process, recorded on the Deck; Genie keeps running: connect ECONNREFUSED genie.example:443']);
    });

    it('both kinds side by side are two items, counted on the Deck’s badge, and Dismiss resolves to Genie’s own command', () => {
        const { proc, book } = installed();
        proc.emit('uncaughtException', thrown('write EPIPE'));
        proc.emit('unhandledRejection', thrown('write EPIPE'));
        const items = book.deckItems();
        expect(items.map((i) => i.id)).toHaveLength(2);
        expect(new Set(items.map((i) => i.id)).size).toBe(2);
        expect(deckBand(items)).toHaveLength(2);
        expect(needsYouCount(items)).toBe(2);
        expect(resolveDeckAnswer(items[0]!, 'dismiss')).toEqual({ kind: 'dismiss-main-error', id: items[0]!.id });
        expect(deckAnswerRoute(items[0]!, 'dismiss')).toEqual({ kind: 'feature' });
        expect(resolveDeckAnswer(items[0]!, 'retry')).toEqual({ kind: 'refused', reason: 'retry is not one of this item’s options' });
    });

    it('a value with no stack, an object, undefined: each is described, never a throw', () => {
        expect(describeThrown({ code: 'EPIPE', syscall: 'write' })).toEqual({ message: '{"code":"EPIPE","syscall":"write"}', stack: null, topFrame: '' });
        expect(describeThrown(undefined)).toEqual({ message: 'undefined', stack: null, topFrame: '' });
        // A code the message does not already say is added to it.
        expect(describeThrown(thrown('the pipe closed', undefined, 'EPIPE')).message).toBe('the pipe closed (EPIPE)');
    });
});

describe('a repeat is a COUNT, never N items', () => {
    it('the same message and top frame three times is one item counted 3, logged at 1 and 2 — then 4', () => {
        let t = 0;
        const { proc, book, lines } = installed({ now: () => ++t });
        for (let i = 0; i < 3; i++) proc.emit('uncaughtException', thrown('write EPIPE'));
        expect(book.list()).toHaveLength(1);
        expect(book.list()[0]).toMatchObject({ count: 3, firstAt: 1, lastAt: 3 });
        expect(book.deckItems()).toHaveLength(1);
        expect(book.deckItems()[0]!.title).toMatch(/— 3 times\. The stack is in Genie’s log\.$/);
        expect(book.deckItems()[0]!.at).toBe(1);
        // A dead stderr can raise an EPIPE for every write: logging every repeat would feed itself. Powers of two stop it.
        expect(lines).toHaveLength(2);
        expect(lines[1]).toBe('[genie] uncaught exception in the main process, recorded on the Deck; Genie keeps running: write EPIPE at PtyHost.write (file:///opt/genie/example/fancy-term-host.js:10:5) — seen 2 times');
        proc.emit('uncaughtException', thrown('write EPIPE'));
        expect(lines).toHaveLength(3);
        expect(lines[2]).toMatch(/— seen 4 times$/);
    });

    it('the same message from a DIFFERENT place is a different problem', () => {
        const { proc, book } = installed();
        proc.emit('uncaughtException', thrown('write EPIPE'));
        proc.emit('uncaughtException', thrown('write EPIPE', 'at Sidecar.send (file:///opt/genie/example/sidecar.js:3:1)'));
        expect(book.list().map((e) => e.count)).toEqual([1, 1]);
    });
});

describe('the list is BOUNDED, and what the bound replaced is said', () => {
    it('past the limit the least-recently-seen error makes room, and an overflow item counts how many did', () => {
        let t = 0;
        const { proc, book } = installed({ now: () => ++t, max: 3 });
        proc.emit('uncaughtException', thrown('one'));
        proc.emit('uncaughtException', thrown('two'));
        proc.emit('uncaughtException', thrown('three'));
        proc.emit('uncaughtException', thrown('one')); // seen again: now the most recent
        proc.emit('uncaughtException', thrown('four'));
        proc.emit('uncaughtException', thrown('five'));
        expect(book.list().map((e) => e.message)).toEqual(['one', 'four', 'five']);
        expect(book.replaced).toBe(2);
        const items = book.deckItems();
        expect(items).toHaveLength(4);
        expect(items[3]).toMatchObject({ id: MAIN_ERROR_OVERFLOW_ID, source: 'genie', title: '2 more errors were recorded in the main process and replaced here to keep this list to 3; each is in Genie’s log.' });
        expect(needsYouCount(items)).toBe(4);
    });

    it('a thousand distinct errors still leave twenty items and one overflow item (the default bound)', () => {
        const { proc, book } = installed();
        for (let i = 0; i < 1_000; i++) proc.emit('uncaughtException', thrown(`failure ${i}`));
        expect(book.list()).toHaveLength(20);
        expect(book.replaced).toBe(980);
        expect(book.deckItems()).toHaveLength(21);
    });
});

describe('Dismiss', () => {
    it('removes the item and says whether it did; the same error again comes back counted from one', () => {
        const { proc, book } = installed();
        proc.emit('uncaughtException', thrown('write EPIPE'));
        proc.emit('uncaughtException', thrown('write EPIPE'));
        const id = book.deckItems()[0]!.id;
        expect(book.dismiss(id)).toBe(true);
        expect(book.deckItems()).toEqual([]);
        expect(book.dismiss(id)).toBe(false);
        proc.emit('uncaughtException', thrown('write EPIPE'));
        expect(book.list()[0]).toMatchObject({ id, count: 1 });
    });

    it('the overflow item’s Dismiss clears its count', () => {
        const { proc, book } = installed({ max: 1 });
        proc.emit('uncaughtException', thrown('one'));
        proc.emit('uncaughtException', thrown('two'));
        expect(book.deckItems().map((i) => i.id)).toContain(MAIN_ERROR_OVERFLOW_ID);
        expect(book.dismiss(MAIN_ERROR_OVERFLOW_ID)).toBe(true);
        expect(book.deckItems().map((i) => i.id)).not.toContain(MAIN_ERROR_OVERFLOW_ID);
        expect(book.dismiss(MAIN_ERROR_OVERFLOW_ID)).toBe(false);
    });

    it('every record and every dismissal tells the Deck at once', () => {
        const { proc, book } = installed();
        let changes = 0;
        book.onChange(() => { changes += 1; });
        proc.emit('uncaughtException', thrown('write EPIPE'));
        proc.emit('uncaughtException', thrown('write EPIPE'));
        book.dismiss(book.deckItems()[0]!.id);
        expect(changes).toBe(3);
    });
});

describe('the handler never throws — a throw from inside it would end the process', () => {
    it('a log that throws (stderr is the dead pipe) and a Deck listener that throws: the error is still recorded', () => {
        const proc = new EventEmitter();
        const book = new MainErrorBook();
        book.onChange(() => { throw new Error('the window is gone'); });
        installMainErrorPolicy(proc, book, () => { throw thrown('write EPIPE', undefined, 'EPIPE'); });
        expect(() => proc.emit('uncaughtException', thrown('write EPIPE'))).not.toThrow();
        expect(() => proc.emit('unhandledRejection', 'genie.example refused')).not.toThrow();
        expect(book.list().map((e) => e.kind)).toEqual(['uncaught-exception', 'unhandled-rejection']);
    });
});
