import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem, SignalState } from '../src/core/deck.js';
import { resolveDeckAnswer } from '../src/core/deck-resolve.js';
import { MainErrorBook, retryHostCopy } from '../src/core/main-errors.js';
import { answerDeck, type DeckAnswerPorts } from '../src/main/deck-answer.js';
import { materializeHostRuntime } from '../src/main/host-runtime.js';
import { Deck } from '../src/renderer/components/Deck.js';

/**
 * THE DECK ITEM GENIE FILES WHEN ITS HOST'S COPY CANNOT BE MADE (Tynn #693; the owner, beta.61: "this is a stupid design
 * and I have no idea what to do here"). Its title was Genie's log sentence with the error and two full paths in it, the
 * opened row drew the same text a second time, and its only action was Dismiss.
 */
const ERROR = 'ENOENT: no such file or directory, copyfile \'C:\\Program Files\\Genie\\resources\\a.exe\' -> \'C:\\Users\\me\\.genie\\host\\x\\a.exe\'';
const TITLE = 'Genie could not copy its background host, so its next update will stop running agents, terminals and sites.';
const MADE = 'Genie’s copy of its background host is made.';
const STILL = 'Genie still could not make the copy. The error is in this item, under Show all.';
const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false } as SignalState;
const NOW = Date.parse('2026-11-11T12:00:00.000Z');

const filed = (error = ERROR) => {
    const book = new MainErrorBook({ now: () => NOW });
    book.record('host-copy', new Error(error));
    return { book, item: book.deckItems()[0]! };
};
const lines = (item: DeckItem) => item.title.split('\n').filter((l) => l.trim() !== '');
const optionsOf = (item: DeckItem) => (item.answer.kind === 'inline' ? item.answer.options.map((o) => `${o.id}=${o.label}`) : []);
const text = (html: string) => html.replace(/&#x27;/g, '\'').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const draw = (items: readonly DeckItem[], more: Partial<Parameters<typeof Deck>[0]> = {}) =>
    text(renderToStaticMarkup(<Deck items={items} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} now={NOW} {...more} />));

describe('the item’s words', () => {
    it('the title is one short sentence: what happened and what it means; the error is not in it', () => {
        const { item } = filed();
        expect(lines(item)[0]).toBe(TITLE);
        expect(item.title).not.toMatch(/ENOENT|copyfile|Program Files|lifecycle\.log/);
    });

    it('what works, why, and what Try again does, each said once under the title', () => {
        expect(lines(filed().item).slice(1)).toEqual([
            'Everything works now. Genie runs your agents, terminals and sites in a background host, and keeps that host on its own copy of the program so that an update can install without ending it. This time the copy could not be made, so the host runs from the installed program.',
            'Try again makes the copy now. The host uses it the next time it starts.',
        ]);
    });

    it('the error is the item’s detail, whole, and nowhere else', () => {
        expect(filed().item.detail).toBe(ERROR);
    });

    it('its actions do something: Try again, Open the log, Dismiss', () => {
        expect(optionsOf(filed().item)).toEqual(['retry=Try again', 'open-log=Open the log', 'dismiss=Dismiss']);
    });

    it('one item however often it fails, holding the latest error', () => {
        const { book } = filed();
        book.record('host-copy', new Error('EPERM: operation not permitted'));
        expect(book.deckItems()).toHaveLength(1);
        expect(book.deckItems()[0]!.detail).toBe('EPERM: operation not permitted');
        expect(book.deckItems()[0]!.title).not.toMatch(/times/);
    });

    it('CONTROL: another kind of error keeps Dismiss, and two different ones are two items', () => {
        const book = new MainErrorBook({ now: () => NOW });
        book.record('uncaught-exception', new Error('one'));
        book.record('uncaught-exception', new Error('two'));
        expect(book.deckItems()).toHaveLength(2);
        expect(optionsOf(book.deckItems()[0]!)).toContain('dismiss=Dismiss');
    });
});

describe('Try again', () => {
    it('made: the item says so, says what is still true, and has only Dismiss', async () => {
        const { book, item } = filed();
        expect(await retryHostCopy(book, item.id, async () => null)).toEqual({ ok: true });
        const after = book.deckItems()[0]!;
        expect(after.id).toBe(item.id);
        expect(lines(after)).toEqual([MADE, 'The host uses it the next time it starts. Until then, an update still stops running agents, terminals and sites.']);
        expect(after.detail).toBeUndefined();
        expect(optionsOf(after)).toEqual(['dismiss=Dismiss']);
    });

    it('not made: the failure in words, the new error in the item, and Try again still there', async () => {
        const { book, item } = filed();
        expect(await retryHostCopy(book, item.id, async () => 'EBUSY: resource busy or locked')).toEqual({ ok: false, reason: STILL });
        const after = book.deckItems()[0]!;
        expect(after.id).toBe(item.id);
        expect(after.detail).toBe('EBUSY: resource busy or locked');
        expect(optionsOf(after)).toContain('retry=Try again');
    });

    it('a copy that throws is a failure in words too, never a silent one', async () => {
        const { book, item } = filed();
        expect(await retryHostCopy(book, item.id, async () => { throw new Error('disk gone'); })).toEqual({ ok: false, reason: STILL });
        expect(book.deckItems()[0]!.detail).toBe('disk gone');
    });

    it('an item that is not there any more is refused in words', async () => {
        const { book } = filed();
        const r = await retryHostCopy(book, 'genie:main-error:nope', async () => null);
        expect(r).toEqual({ ok: false, reason: 'This item is no longer on the Deck. Nothing was done.' });
    });
});

describe('each button reaches its action', () => {
    const ports = (mainErrors: DeckAnswerPorts['mainErrors']): DeckAnswerPorts => ({ mainErrors } as unknown as DeckAnswerPorts);

    it('the option says which', () => {
        const { item } = filed();
        expect(resolveDeckAnswer(item, 'retry')).toEqual({ kind: 'retry-host-copy', id: item.id });
        expect(resolveDeckAnswer(item, 'open-log')).toEqual({ kind: 'open-lifecycle-log' });
        expect(resolveDeckAnswer(item, 'dismiss')).toEqual({ kind: 'dismiss-main-error', id: item.id });
    });

    it('Try again runs the copy; a failure comes back as its words', async () => {
        const { item } = filed();
        const asked: string[] = [];
        await answerDeck({ kind: 'deck.answer', item, optionId: 'retry' }, ports({ dismiss: () => true, retryHostCopy: async (id) => { asked.push(id); return { ok: true }; } }));
        expect(asked).toEqual([item.id]);
        await expect(answerDeck({ kind: 'deck.answer', item, optionId: 'retry' }, ports({ dismiss: () => true, retryHostCopy: async () => ({ ok: false, reason: STILL }) }))).rejects.toThrow(STILL);
    });

    it('Open the log opens it; a log that cannot be opened says why', async () => {
        const { item } = filed();
        let opened = 0;
        await answerDeck({ kind: 'deck.answer', item, optionId: 'open-log' }, ports({ dismiss: () => true, openLog: async () => { opened += 1; return null; } }));
        expect(opened).toBe(1);
        await expect(answerDeck({ kind: 'deck.answer', item, optionId: 'open-log' }, ports({ dismiss: () => true, openLog: async () => 'no app opens .log files' }))).rejects.toThrow('Genie could not open the log: no app opens .log files');
    });

    it('where neither is wired, each says so instead of doing nothing', async () => {
        const { item } = filed();
        await expect(answerDeck({ kind: 'deck.answer', item, optionId: 'retry' }, ports({ dismiss: () => true }))).rejects.toThrow(/needs Genie’s window on this machine/);
        await expect(answerDeck({ kind: 'deck.answer', item, optionId: 'open-log' }, ports({ dismiss: () => true }))).rejects.toThrow(/needs Genie’s window on this machine/);
    });
});

describe('the copy says its error apart from Genie’s sentence', () => {
    it('`cause` is the error alone; `error` keeps the sentence the log has', async () => {
        const root = mkdtempSync(join(tmpdir(), 'deck-host-copy-'));
        try {
            const got = await materializeHostRuntime({ packaged: true, platform: 'win32', arch: 'x64', execPath: join(root, 'install', 'Genie.exe'), electronVersion: '45.0.0', appRoot: join(root, 'install', 'resources', 'app'), unpackedRoot: join(root, 'install', 'resources', 'app.unpacked'), hostHash: 'abc', genieHome: join(root, 'home'), log: () => {} });
            expect(got.cause).toBe('Genie.exe is not in the install');
            expect(got.error).toBe('Genie runs its host from the install this session; the copy could not be made: Genie.exe is not in the install');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('the row, drawn', () => {
    it('closed: the short title and Show all; no error on screen', () => {
        const html = draw([filed().item]);
        expect(html).toContain(TITLE);
        expect(html).toContain('Show all');
        expect(html).not.toContain('ENOENT');
    });

    it('opened: the error once, as the folded detail, and not in the title', () => {
        const { item } = filed();
        const html = draw([item], { initiallyExpanded: [item.id] });
        expect(count(html, 'ENOENT')).toBe(1);
        expect(html).toMatch(/<pre[^>]*data-deck-detail="[^"]*"[^>]*>ENOENT: no such file or directory, copyfile/);
        expect(count(html, 'Everything works now.')).toBe(1);
        expect(count(html, TITLE)).toBe(1);
    });

    it('EVERY item whose body is its title: opened, its text is on screen once (it was drawn twice)', () => {
        const long = `Genie kept a note for you about ${'a very long line of words '.repeat(8)}and this is how it ENDS-ONCE.`;
        const item: DeckItem = { ...filed().item, id: 'genie:main-error:long', title: long, detail: undefined };
        expect(count(draw([item], { initiallyExpanded: [item.id] }), 'ENDS-ONCE')).toBe(1);
    });

    it('CONTROL: an item with more than its title still shows the rest when opened', () => {
        const item: DeckItem = { ...filed().item, id: 'genie:main-error:two', title: 'A title.\nAnd a second line, SHOWN-BELOW.', detail: undefined };
        expect(draw([item])).not.toContain('SHOWN-BELOW');
        expect(count(draw([item], { initiallyExpanded: [item.id] }), 'SHOWN-BELOW')).toBe(1);
    });

    it('while Try again runs: that button shows progress and the row takes no second press', () => {
        const { item } = filed();
        const html = draw([item], { busy: { itemId: item.id, optionId: 'retry' } });
        expect(html).toMatch(new RegExp(`data-deck-busy="retry"`));
        for (const id of ['retry', 'open-log', 'dismiss']) expect(html.match(new RegExp(`<button[^>]*data-approval-option="${id}"[^>]*>`))?.[0]).toMatch(/ disabled=""/);
    });

    it('CONTROL: nothing running, every button can be pressed', () => {
        const html = draw([filed().item]);
        expect(html).not.toContain('data-deck-busy');
        for (const id of ['retry', 'open-log', 'dismiss']) expect(html.match(new RegExp(`<button[^>]*data-approval-option="${id}"[^>]*>`))?.[0]).not.toMatch(/ disabled=""/);
    });
});

describe('the other items Genie files about its host', () => {
    it('one that points at the lifecycle log has Open the log', () => {
        for (const kind of ['agent-host', 'containment-unready', 'stop-unverified'] as const) {
            const book = new MainErrorBook({ now: () => NOW });
            book.record(kind, new Error('something'));
            expect(optionsOf(book.deckItems()[0]!), kind).toEqual(['open-log=Open the log', 'dismiss=Dismiss']);
        }
    });
});

describe('the window is wired to it', () => {
    const app = readFileSync('src/renderer/App.tsx', 'utf8');
    const main = readFileSync('src/main/main.ts', 'utf8');

    it('the window files the item with the error alone, and wires both actions', () => {
        expect(main).toMatch(/mainErrors\.record\('host-copy', new Error\(hostRuntime\.cause \?\? hostRuntime\.error\)\)/);
        expect(main).not.toMatch(/mainErrors\.record\('agent-host', new Error\(hostRuntime\.error\)\)/);
        expect(main).toMatch(/retryHostCopy: \(id\) => retryHostCopy\(mainErrors, id, /);
        // Internal errors select the browser log by ID; host-copy items still use the default lifecycle log.
        const openLog = main.slice(main.indexOf('openLog: (id) => {'), main.indexOf('report: async (id) => {'));
        expect(openLog).toContain("join(genieRoot(), 'logs', 'genie-browser.log')");
        expect(openLog).toContain("join(runtimeDir(genieRoot()), 'lifecycle.log')");
        expect(openLog).toContain('shell.openPath(path)');
    });

    it('the Deck is told which action is running, until it ends either way', () => {
        expect(app).toMatch(/setDeckBusy\(\{ itemId: item\.id, optionId \}\)/);
        expect(app).toMatch(/\.finally\(\(\) => setDeckBusy\(null\)\)/);
    });
});
