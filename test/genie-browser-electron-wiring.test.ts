import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE GENIE BROWSER WINDOW'S ELECTRON WIRING, READ FROM SOURCE (beta.35 item 36) — `genie-browser-electron.ts` is
 * Electron-only, so its load-bearing lines are checked here; the rules they apply are tested in genie-browser-core /
 * genie-browser-window / browser-origins / browser-trust. Line comments stripped line by line (CRLF-safe). Counted.
 */

const code = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');

const win = code('../src/main/genie-browser-electron.ts');
const preload = code('../src/main/browser-preload.ts');
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe('the window’s session', () => {
    it('its own partition — never the app’s default session, nor the old pane’s', () => {
        expect(count(win, /session\.fromPartition\('persist:genie-browser-window'\)/g)).toBe(1);
        expect(count(win, /defaultSession|'persist:genie-browser'/g)).toBe(0);
    });

    it('.gen routed to the front door, trusted only on Genie’s CA by the verifier’s verdict, every request secure-only', () => {
        expect(count(win, /ses\.setProxy\(genProxyConfig\(/g)).toBe(1);
        expect(count(win, /ses\.setCertificateVerifyProc\(/g)).toBe(1);
        expect(count(win, /callback\(\s*-?\d+\s*\)/g)).toBe(0);
        expect(count(win, /ses\.webRequest\.onBeforeRequest\(/g)).toBe(1);
        expect(win).toMatch(/callback\(\{ cancel: !isSecureBrowserUrl\(details\.url\) \}\)/);
    });

    it('a page load waits for the routing (a .gen load before it would go to DNS)', () => {
        expect(win).toMatch(/await routed;\s*await view\.webContents\.loadURL\(url\)/);
    });
});

describe('each tab’s page', () => {
    it('isolated from Node, NO preload — and sandbox OFF, because a sandboxed child view renders blank (electron#44897)', () => {
        const prefs = /new WebContentsView\(\{ webPreferences: \{([^}]*)\} \}\)/.exec(win)?.[1] ?? '';
        expect(prefs).toMatch(/contextIsolation: true/);
        expect(prefs).toMatch(/nodeIntegration: false/);
        expect(prefs).toMatch(/sandbox: false/);
        expect(prefs).not.toMatch(/preload/);
        expect(count(win, /new WebContentsView\(/g)).toBe(1);
    });

    it('a new window is never a window: handed to the brain (a tab, for a Genie site), then denied', () => {
        expect(win).toMatch(/setWindowOpenHandler\(\(\{ url \}\) => \{\s*events\.openWindow\(url\);\s*return \{ action: 'deny' \};/);
    });

    it('a link off the Genie sites leaves for the machine’s browser instead of loading here', () => {
        expect(count(win, /wc\.on\('will-navigate'/g)).toBe(1);
        expect(win).toMatch(/event\.preventDefault\(\)/);
        expect(win).toMatch(/shell\.openExternal/);
    });

    it('a closed tab’s page is taken off the window and closed', () => {
        expect(win).toMatch(/removeChildView\(view\)/);
        expect(win).toMatch(/wc\.close\(\)/);
    });
});

describe('the chrome', () => {
    it('loads browser.html with its own preload, sandboxed; the preload exposes genieBrowser and nothing else', () => {
        expect(win).toMatch(/loadFile\(join\(options\.here, '\.\.\/renderer\/browser\.html'\)\)/);
        expect(count(preload, /exposeInMainWorld\(/g)).toBe(1);
        expect(preload).toMatch(/exposeInMainWorld\('genieBrowser'/);
    });

    it('every call is answered only for the browser window’s own chrome', () => {
        const handles = count(win, /ipcMain\.handle\('browser-window:/g);
        const guarded = count(win, /ipcMain\.handle\('browser-window:[^']+', \(event[^)]*\) => \{?\s*(const b = )?brain\(event\)/g);
        expect(handles).toBeGreaterThanOrEqual(12);
        expect(guarded).toBe(handles);
    });
});
