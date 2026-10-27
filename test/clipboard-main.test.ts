import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_WRITE_CHANNEL, MAX_CLIPBOARD_CHARS } from '../src/core/clipboard-wire.js';
import { electronClipboardPort, registerClipboardIpc, writeClipboard, type ClipboardPort } from '../src/main/clipboard-ipc.js';
import { genieClipboardWriter } from '../src/renderer/clipboard.js';
import { ICON_NAMES } from '../src/renderer/icons.js';

/**
 * A COPY GOES THROUGH ELECTRON'S CLIPBOARD, IN MAIN (genie#1263 follow-up, react-fancy 5.67.0's `clipboardWriter`).
 *
 * Genie 1 found that `navigator.clipboard` can fail SILENTLY in a sandboxed Electron window (v0.7.0-beta.342,
 * `renderer/components/Terminal/Terminal.tsx`): the promise resolves, nothing is on the clipboard, and the button says
 * "Copied". So every copy button Genie draws, and every one react-fancy draws for it, writes through one narrow IPC to
 * main, where Electron's `clipboard.write` puts text (and HTML, when there is some) on the clipboard and the text is READ BACK — a
 * write that did not land is a failed copy, announced as one.
 */

class FakeClipboard implements ClipboardPort {
    held = '';
    writes: Array<{ text: string; html?: string }> = [];
    constructor(private readonly lands = true, private readonly crlf = false) {}
    async write(data: { text: string; html?: string }): Promise<void> {
        this.writes.push(data);
        if (this.lands) this.held = this.crlf ? data.text.replace(/\n/g, '\r\n') : data.text;
    }
    async readText(): Promise<string> { return this.held; }
}

describe('writeClipboard — main writes, then checks the write landed', () => {
    it('text and HTML go to the clipboard in ONE write, and a write that landed is true', async () => {
        const c = new FakeClipboard();
        expect(await writeClipboard({ text: 'Signed: Acme', html: '<p><strong>Signed:</strong> Acme</p>' }, c)).toBe(true);
        expect(c.writes).toEqual([{ text: 'Signed: Acme', html: '<p><strong>Signed:</strong> Acme</p>' }]);
    });

    it('text alone is written as text alone (no empty HTML flavour)', async () => {
        const c = new FakeClipboard();
        expect(await writeClipboard({ text: 'npm ci' }, c)).toBe(true);
        expect(c.writes).toEqual([{ text: 'npm ci' }]);
    });

    it('a write that SILENTLY did nothing is a failed copy — the failure the renderer could not see', async () => {
        const c = new FakeClipboard(false);
        c.held = 'what was there before';
        expect(await writeClipboard({ text: 'npm ci' }, c)).toBe(false);
    });

    it('a write that rejects is a failed copy', async () => {
        const c: ClipboardPort = { write: async () => { throw new Error('clipboard busy'); }, readText: async () => '' };
        expect(await writeClipboard({ text: 'x' }, c)).toBe(false);
    });

    it('CONTROL: Windows hands the text back with CRLF line ends — that is the same text, so it is true', async () => {
        expect(await writeClipboard({ text: 'a\nb' }, new FakeClipboard(true, true))).toBe(true);
    });

    it('anything but {text: string, html?: string} within the size cap is refused WITHOUT writing', async () => {
        for (const bad of [null, 'x', { text: 1 }, { text: 'x', html: 2 }, { text: 'x'.repeat(MAX_CLIPBOARD_CHARS + 1) }, { text: 'x', html: 'x'.repeat(MAX_CLIPBOARD_CHARS + 1) }]) {
            const c = new FakeClipboard();
            expect(await writeClipboard(bad, c)).toBe(false);
            expect(c.writes).toEqual([]);
        }
    });
});

describe('electronClipboardPort — Electron 45’s clipboard: one ClipboardItem per copy, read back as text', () => {
    class Item { constructor(public readonly data: Record<string, string>) {} }

    it('text and HTML are ONE item with text/plain and text/html; text alone is text/plain alone', async () => {
        const written: Item[][] = [];
        const port = electronClipboardPort({ write: async (items: Item[]) => { written.push(items); }, readText: async () => 'x' }, Item);
        await port.write({ text: 'x', html: '<b>x</b>' });
        await port.write({ text: 'y' });
        expect(written.map((items) => items.map((i) => i.data))).toEqual([[{ 'text/plain': 'x', 'text/html': '<b>x</b>' }], [{ 'text/plain': 'y' }]]);
        expect(await port.readText()).toBe('x');
    });
});

describe('the IPC: one channel, named once, handled by main and invoked by every preload that needs it', () => {
    it('registerClipboardIpc answers the channel with writeClipboard', async () => {
        const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
        const c = new FakeClipboard();
        registerClipboardIpc({ handle: (ch, fn) => { handlers.set(ch, fn); } }, c);
        expect([...handlers.keys()]).toEqual([CLIPBOARD_WRITE_CHANNEL]);
        expect(await handlers.get(CLIPBOARD_WRITE_CHANNEL)!({}, { text: 'ok' })).toBe(true);
        expect(c.writes).toEqual([{ text: 'ok' }]);
    });

    it('main registers it with Electron’s clipboard; neither main nor a preload retypes the channel', () => {
        const wired = /registerClipboardIpc\(ipcMain, electronClipboardPort\(clipboard, ClipboardItem\)\)/;
        expect(readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')).toMatch(wired);
        // `genie --doctor` is its own main: its chat has copy buttons too.
        expect(readFileSync(new URL('../src/main/doctor.ts', import.meta.url), 'utf8')).toMatch(wired);
        for (const f of ['main.ts', 'doctor.ts', 'clipboard-ipc.ts']) {
            expect(readFileSync(new URL(`../src/main/${f}`, import.meta.url), 'utf8')).not.toContain(`'${CLIPBOARD_WRITE_CHANNEL}'`);
        }
    });

    /*
     * A SANDBOXED PRELOAD CANNOT REQUIRE ANOTHER FILE. The four preloads are one Rollup build with four entries: a module
     * two of them import becomes a shared chunk each `require()`s — and a sandboxed preload can require only `electron`,
     * so it throws and the window opens with no bridge at all (this PR's first CI smoke: `window.genie` undefined). So a
     * preload writes the channel out itself, and this holds every copy equal to the one constant.
     */
    const PRELOADS = ['preload.ts', 'question-preload.ts', 'doctor-preload.ts', 'browser-preload.ts'];
    const valueImports = (f: string) => [...readFileSync(new URL(`../src/main/${f}`, import.meta.url), 'utf8').matchAll(/^import (?!type )[^;]*? from '(\.[^']+)';/gm)].map((m) => m[1]!);

    it('no two preloads import the same module of Genie’s (it would be a shared chunk a sandboxed preload cannot load)', () => {
        const seen = new Map<string, string>();
        const shared: string[] = [];
        for (const f of PRELOADS) {
            for (const m of valueImports(f)) {
                const key = new URL(m, new URL(`../src/main/${f}`, import.meta.url)).pathname;
                if (seen.has(key) && seen.get(key) !== f) shared.push(`${m} (${seen.get(key)} and ${f})`);
                seen.set(key, f);
            }
        }
        // CONTROL: the scan sees value imports at all (Genie's preload imports FEATURE_CHANNELS).
        expect(valueImports('preload.ts').length).toBeGreaterThan(0);
        expect(shared).toEqual([]);
    });

    it('each preload that exposes genieClipboard writes the channel exactly as the constant has it', () => {
        for (const f of ['preload.ts', 'question-preload.ts', 'doctor-preload.ts']) {
            const src = readFileSync(new URL(`../src/main/${f}`, import.meta.url), 'utf8');
            expect((src.match(/'genie:clipboard-[\w-]+'/g) ?? [])).toEqual([`'${CLIPBOARD_WRITE_CHANNEL}'`]);
        }
    });
});

const ipc = vi.hoisted(() => ({
    exposed: new Map<string, Record<string, (...args: unknown[]) => unknown>>(),
    invoked: [] as unknown[][],
}));
vi.mock('electron', () => ({
    ipcMain: { handle: () => {}, on: () => {} },
    ipcRenderer: { invoke: (...args: unknown[]) => { ipc.invoked.push(args); return Promise.resolve(true); }, on: () => {}, removeListener: () => {}, send: () => {} },
    contextBridge: { exposeInMainWorld: (name: string, api: Record<string, (...args: unknown[]) => unknown>) => { ipc.exposed.set(name, api); } },
    BrowserWindow: class {},
    screen: {},
    shell: {},
    clipboard: {},
}));

describe('every window that draws rendered Markdown (main, question, doctor) gets `genieClipboard`, and nothing more', () => {
    const preloads: Record<string, () => Promise<unknown>> = {
        preload: () => import('../src/main/preload.js'),
        'question-preload': () => import('../src/main/question-preload.js'),
        'doctor-preload': () => import('../src/main/doctor-preload.js'),
    };
    it.each(Object.keys(preloads))('%s exposes genieClipboard.write(text, html?) → the channel', async (name) => {
        ipc.invoked.length = 0;
        ipc.exposed.delete('genieClipboard');
        await preloads[name]!();
        const api = ipc.exposed.get('genieClipboard')!;
        expect(Object.keys(api)).toEqual(['write']);
        await api.write!('x', '<b>x</b>');
        await api.write!('y');
        expect(ipc.invoked).toEqual([[CLIPBOARD_WRITE_CHANNEL, { text: 'x', html: '<b>x</b>' }], [CLIPBOARD_WRITE_CHANNEL, { text: 'y' }]]);
    });
});

describe('genieClipboardWriter — react-fancy’s copy buttons write through it', () => {
    const g = globalThis as { genieClipboard?: { write: (text: string, html?: string) => Promise<boolean> } };
    afterEach(() => { delete g.genieClipboard; });

    it('a copy main confirms is true; one main refuses is FALSE, which react-fancy announces as "Copy failed"', async () => {
        const sent: unknown[][] = [];
        g.genieClipboard = { write: async (...a) => { sent.push(a); return true; } };
        expect(await genieClipboardWriter({ kind: 'code', text: 'ls', html: '<pre><code>ls</code></pre>' })).toBe(true);
        expect(sent).toEqual([['ls']]);
        g.genieClipboard = { write: async () => false };
        expect(await genieClipboardWriter({ kind: 'code', text: 'ls', html: '<pre><code>ls</code></pre>' })).toBe(false);
    });

    it('a table goes with its HTML', async () => {
        const sent: unknown[][] = [];
        g.genieClipboard = { write: async (...a) => { sent.push(a); return true; } };
        await genieClipboardWriter({ kind: 'table', text: 'a', html: '<table><tr><td>a</td></tr></table>' });
        expect(sent).toEqual([['a', '<table><tr><td>a</td></tr></table>']]);
    });
});

describe('EVERY ContentRenderer Genie draws routes its copies through Genie’s writer', () => {
    // react-fancy 5.67 turned copy buttons ON for every ContentRenderer. One left on the default writer is a copy button
    // that can say "Copied" for a copy that never happened, in exactly the sandboxed window Genie runs in.
    const dir = new URL('../src/renderer/components/', import.meta.url);
    const uses = readdirSync(dir).filter((f) => f.endsWith('.tsx')).flatMap((f) => {
        const src = readFileSync(new URL(f, dir), 'utf8');
        return [...src.matchAll(/<ContentRenderer\b[\s\S]*?\/>/g)].map((m) => ({ f, tag: m[0] }));
    });

    it('COUNTED: every one passes clipboardWriter={genieClipboardWriter}', () => {
        // The control: the scan finds them (the chat, the inbox, the plugin pane, the question window and form, the
        // update and what's-new windows).
        expect(uses.length).toBeGreaterThanOrEqual(7);
        expect(uses.filter((u) => !u.tag.includes('clipboardWriter={genieClipboardWriter}')).map((u) => u.f)).toEqual([]);
    });

    it('react-fancy’s copy buttons ask for copy, check and x: all three are registered (an unregistered icon is a blank)', () => {
        for (const name of ['copy', 'check', 'x']) expect(ICON_NAMES).toContain(name);
    });
});
