import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { browserWindowBounds, browserWindowMove } from '../src/core/browser-placement.js';
import { BrowserService, type BrowserEvent, type BrowserFacts } from '../src/main/browser-service.js';
import { runBrowserLink, type BrowserLinkClient } from '../src/main/browser-process-link.js';

/**
 * THE GENIE BROWSER WINDOW OPENS IN VIEW (Tynn #739; client onboarding call, 2026-11-16, transcript 00:30:49). The owner,
 * driving remotely, had to go looking for the browser; on the client's two-monitor laptop it "popped open on another
 * screen". It was made with no position (Electron centres a window on the PRIMARY display, whichever the person was
 * looking at) at a fixed 1200 x 820 (taller than a 1366 x 768 laptop's work area, so its bottom ran off the screen).
 * Now it opens centred over the Genie window that asked, inside that display's work area, cut to fit, and focused.
 */

const SIZE = { width: 1200, height: 820 };

describe('where a fresh browser window goes (core/browser-placement.ts)', () => {
    it('centred over the window that asked, on that window’s display (a second monitor left of the primary)', () => {
        const workArea = { x: -1920, y: 0, width: 1920, height: 1040 };
        expect(browserWindowBounds({ anchor: { x: -1800, y: 100, width: 1440, height: 900 }, workArea, size: SIZE })).toEqual({ x: -1680, y: 140, width: 1200, height: 820 });
    });

    it('cut to a laptop’s work area, so its bottom is never off the screen', () => {
        const workArea = { x: 0, y: 0, width: 1366, height: 728 };
        expect(browserWindowBounds({ anchor: { x: 0, y: 0, width: 1366, height: 728 }, workArea, size: SIZE })).toEqual({ x: 83, y: 0, width: 1200, height: 728 });
    });

    it('no window asked (an agent’s open): the centre of the work area', () => {
        expect(browserWindowBounds({ anchor: null, workArea: { x: 1920, y: 0, width: 2560, height: 1400 }, size: SIZE })).toEqual({ x: 2600, y: 290, width: 1200, height: 820 });
    });

    it('an asking window near an edge: the browser is kept inside the work area', () => {
        const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
        expect(browserWindowBounds({ anchor: { x: 1700, y: 900, width: 400, height: 300 }, workArea, size: SIZE })).toEqual({ x: 720, y: 220, width: 1200, height: 820 });
    });

    it('CONTROL: on a display it fits, the window keeps its own 1200 x 820', () => {
        const b = browserWindowBounds({ anchor: null, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, size: SIZE });
        expect({ width: b.width, height: b.height }).toEqual(SIZE);
    });
});

describe('an open browser window and the person’s click', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
    const anchor = { x: 240, y: 70, width: 1440, height: 900 };

    it('the person’s click, the window on another display: it is moved to the asking window’s display, centred there', () => {
        expect(browserWindowMove({ activation: 'user-gesture', onAnchorDisplay: false, anchor, workArea, size: SIZE })).toEqual({ x: 360, y: 110, width: 1200, height: 820 });
    });

    it('CONTROL: on the same display, or an agent’s open, it stays where the person put it', () => {
        expect(browserWindowMove({ activation: 'user-gesture', onAnchorDisplay: true, anchor, workArea, size: SIZE })).toBeNull();
        expect(browserWindowMove({ activation: 'background', onAnchorDisplay: false, anchor, workArea, size: SIZE })).toBeNull();
    });
});

const FACTS: BrowserFacts = { frontDoorPort: 4443, caPem: 'CA', hosts: ['shop.gen'], workspaceOf: { 'shop.gen': 'ws' }, launch: { file: 'Genie.exe', args: ['--genie-browser'] } };

describe('the asking window’s bounds travel to the browser', () => {
    it('the host carries the anchor on the open it hands the browser (an absent remote travels as null)', async () => {
        const service = new BrowserService({});
        const events: BrowserEvent[] = [];
        service.onEvent((e) => events.push(e));
        await service.call('register', [], 'browser');
        await service.call('open', [null, 'user-gesture', null, { x: -1800, y: 100, width: 1440, height: 900 }], 'window');
        expect(events.at(-1)).toMatchObject({ kind: 'open', url: null, activation: 'user-gesture', anchor: { x: -1800, y: 100, width: 1440, height: 900 } });
    });

    it('CONTROL: an anchor that is not a rectangle is dropped, never a refusal: the browser still opens', async () => {
        const service = new BrowserService({});
        const events: BrowserEvent[] = [];
        service.onEvent((e) => events.push(e));
        await service.call('register', [], 'browser');
        await service.call('open', ['https://shop.gen/', 'user-gesture', null, { x: 'left', y: 0, width: 10, height: 10 }], 'window');
        const open = events.at(-1) as { kind: string; anchor?: unknown };
        expect(open.kind).toBe('open');
        expect(open.anchor).toBeUndefined();
    });

    it('the browser process hands the anchor to the window', async () => {
        let listener: (event: BrowserEvent) => void = () => {};
        const client: BrowserLinkClient = { browserCall: vi.fn(async () => ({ facts: FACTS, doorUp: true })), onBrowserEvent: (l) => { listener = l; return () => {}; }, close: vi.fn() };
        const ports = { connect: vi.fn(async () => client), sleep: vi.fn(async () => {}), facts: vi.fn(), door: vi.fn(), open: vi.fn(), quit: vi.fn(), linked: vi.fn(), log: vi.fn() };
        const link = runBrowserLink(ports);
        await link.linked;
        listener({ kind: 'open', url: null, activation: 'user-gesture', anchor: { x: 1, y: 2, width: 3, height: 4 } });
        expect(ports.open).toHaveBeenLastCalledWith(null, 'user-gesture', undefined, { x: 1, y: 2, width: 3, height: 4 });
        link.stop();
    });
});

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

describe('the wiring (source)', () => {
    const main = source('../src/main/main.ts');
    const win = source('../src/main/genie-browser-electron.ts');
    const proc = source('../src/main/browser-process.ts');

    it('the rail’s Browser: main sends the asking window’s bounds with the open', () => {
        expect(main).toMatch(/const anchor = BrowserWindow\.fromWebContents\(event\.sender\)\?\.getBounds\(\) \?\? null;/);
        expect(main).toMatch(/openLocalBrowser\(at, 'user-gesture', anchor\)/);
        expect(main).toMatch(/askBrowser\(\[at \?\? null, 'user-gesture', \{[^\]]*\}, anchor\]\)/);
    });

    it('a site row’s Open (the person’s click): the focused Genie window is the anchor', () => {
        expect(main).toMatch(/activation === 'user-gesture' \? BrowserWindow\.getFocusedWindow\(\)\?\.getBounds\(\) \?\? null : null/);
    });

    it('the window is placed on the anchor’s display (else the cursor’s), and an open one moved by the rule', () => {
        expect(win).toMatch(/browserWindowBounds\(/);
        expect(win).toMatch(/screen\.getDisplayMatching\(anchor\)/);
        expect(win).toMatch(/screen\.getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)/);
        expect(win).toMatch(/browserWindowMove\(/);
    });

    it('the browser process passes the anchor to the window', () => {
        expect(proc).toMatch(/open: \(url, activation, remote, anchor\) =>/);
        expect(proc).toMatch(/ : undefined, anchor\);/);
    });
});
