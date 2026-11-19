// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { menuAnchor, sitesMenuItems } from '../src/core/browser-sites.js';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { BrowserSitesRow } from '../src/renderer/components/BrowserSitesRow.js';

/**
 * THE SITES BAR'S "»" OPENS ITS MENU (Tynn #900). The owner, 2026-11-18: clicking » did nothing. The cause: the » opened a
 * react-fancy Dropdown in the chrome's own DOM, dropping DOWN into the page box, and main places the active tab's page (an
 * Electron WebContentsView, a native view) over that box, so the menu was drawn under the page. It only ever showed on the
 * welcome page. The fix: the » asks main for a NATIVE menu (an OS popup, above every view, arrow keys / Enter / Esc by the
 * OS), built only from the hosts main itself lists; the pick opens through the chips' own path.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SITES = ['tynn.gen', 'moic.gen', 'fancy.gen', 'genie.gen'];

describe('the row: » asks for the menu, the pick opens', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); });

    const more = () => host.querySelector<HTMLButtonElement>('[data-browser-sites-more] button');

    it('clicking » asks for a menu of EVERY hidden site, anchored under the button; the picked one opens', async () => {
        const onOpen = vi.fn();
        const onMore = vi.fn(async () => 'genie.gen' as string | null);
        act(() => root.render(<BrowserSitesRow sites={SITES} current="moic.gen" fit={2} onOpen={onOpen} onMore={onMore} />));
        const button = more();
        expect(button).not.toBeNull();
        expect(button!.tagName).toBe('BUTTON'); // Enter / Space click it natively
        expect(button!.getAttribute('aria-haspopup')).toBe('menu');
        await act(async () => { button!.click(); });
        expect(onMore).toHaveBeenCalledTimes(1);
        const [hosts, at] = onMore.mock.calls[0] as unknown as [string[], { x: number; y: number }];
        expect(hosts).toEqual(['fancy.gen', 'genie.gen']);
        expect(Number.isFinite(at.x) && Number.isFinite(at.y)).toBe(true);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onOpen).toHaveBeenCalledWith('https://genie.gen/');
    });

    it('CONTROL: the menu dismissed (Esc, a click away) opens nothing', async () => {
        const onOpen = vi.fn();
        const onMore = vi.fn(async () => null);
        act(() => root.render(<BrowserSitesRow sites={SITES} current={null} fit={1} onOpen={onOpen} onMore={onMore} />));
        await act(async () => { more()!.click(); });
        expect(onMore).toHaveBeenCalledTimes(1);
        expect((onMore.mock.calls[0] as unknown as [string[]])[0]).toEqual(['moic.gen', 'fancy.gen', 'genie.gen']);
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('no menu is drawn in the chrome’s DOM: it would sit under the page view', async () => {
        act(() => root.render(<BrowserSitesRow sites={SITES} current={null} fit={2} onOpen={() => {}} onMore={async () => null} />));
        await act(async () => { more()!.click(); });
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.querySelector('[data-react-fancy-dropdown]')).toBeNull();
    });
});

describe('sitesMenuItems: main builds the menu from ITS OWN list', () => {
    const labels = { 'genie.gen': 'Genie', 'fancy.gen': 'Fancy · docs' };
    it('the asked hosts, in order, labelled, the current one checked', () => {
        expect(sitesMenuItems({ requested: ['fancy.gen', 'genie.gen'], sites: SITES, labels, current: 'genie.gen' })).toEqual([
            { host: 'fancy.gen', label: 'Fancy · docs', checked: false },
            { host: 'genie.gen', label: 'Genie', checked: true },
        ]);
    });
    it('a host main does not list, a non-string, or a repeat is dropped', () => {
        expect(sitesMenuItems({ requested: ['evil.example', 'moic.gen', 42, 'moic.gen', null], sites: SITES, labels: {}, current: null })).toEqual([
            { host: 'moic.gen', label: 'moic', checked: false },
        ]);
        expect(sitesMenuItems({ requested: 'moic.gen', sites: SITES, labels: {}, current: null })).toEqual([]);
    });
});

describe('menuAnchor: the point under the », or nothing', () => {
    it('whole pixels from a finite point', () => {
        expect(menuAnchor({ x: 412.6, y: 101.2 })).toEqual({ x: 413, y: 101 });
    });
    it('null for anything else', () => {
        expect(menuAnchor(null)).toBeNull();
        expect(menuAnchor({ x: Number.NaN, y: 3 })).toBeNull();
        expect(menuAnchor({ x: '1', y: 3 })).toBeNull();
        expect(menuAnchor({ x: -5, y: 3 })).toBeNull();
    });
});

const code = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

describe('the wiring (Electron-only, read from source)', () => {
    const win = code('../src/main/genie-browser-electron.ts');
    const preload = code('../src/main/browser-preload.ts');
    const page = code('../src/renderer/browser-main.tsx');
    const chrome = code('../src/renderer/components/GenieBrowserChrome.tsx');
    const row = code('../src/renderer/components/BrowserSitesRow.tsx');

    it('main answers browser-window:sites-menu for a browser window only, with a native menu over that window, from its own list', () => {
        expect(win).toMatch(/ipcMain\.handle\('browser-window:sites-menu'/);
        expect(win).toMatch(/sitesMenuItems\(\{ requested[^}]*sites: snap\.sites/);
        expect(win).toMatch(/Menu\.buildFromTemplate\([\s\S]{0,400}\.popup\(\{ window: w,/);
        expect(IPC_INVENTORY).toContainEqual(['browser-window:sites-menu', 'browser-process']);
    });
    it('the preload, the window and the chrome pass it through to the row', () => {
        expect(preload).toMatch(/sitesMenu: \(hosts: readonly string\[\], at: \{ x: number; y: number \}\) => ipcRenderer\.invoke\('browser-window:sites-menu', hosts, at\)/);
        expect(page).toMatch(/onSitesMenu=\{\(hosts, at\) => bridge\.sitesMenu\(hosts, at\)\}/);
        expect(chrome).toMatch(/<BrowserSitesRow [^>]*onMore=\{p\.onSitesMenu\}/);
    });
    it('the row no longer draws a DOM dropdown', () => {
        expect(row).not.toMatch(/Dropdown/);
    });
});
