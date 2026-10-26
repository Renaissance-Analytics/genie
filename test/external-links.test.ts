import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { externalUrl, guardWindowLinks } from '../src/main/external-links.js';

/**
 * A LINK OPENS IN THE BROWSER, NEVER IN GENIE (Tynn #763 row 65; Genie 1's clickable terminal URLs, now fancy-term 0.7.0's
 * `onLinkActivate`). A URL in a terminal is clickable; a link in a page (the GitHub panel's, a rendered reply's) opens in
 * the person's browser. Only http(s) ever leaves — never `file:`, `javascript:` or anything else — and a Genie window is
 * never navigated away from Genie: Electron's default for `target="_blank"` was a NEW Genie window showing the site.
 */
describe('what may leave', () => {
    it('http(s) only (COUNTED: two of six)', () => {
        const urls = ['https://example.com/x', 'http://localhost:8080', 'file:///etc/passwd', 'javascript:alert(1)', 'genie://dashboard', 'not a url'];
        expect(urls.filter((u) => externalUrl(u) !== null)).toEqual(['https://example.com/x', 'http://localhost:8080']);
    });
});

describe('a window’s links', () => {
    const rig = () => {
        let openHandler: ((d: { url: string }) => { action: 'deny' | 'allow' }) | null = null;
        let navigate: ((event: { preventDefault(): void }, url: string) => void) | null = null;
        const opened: string[] = [];
        const contents = {
            getURL: () => 'file:///app/index.html#genie://dashboard',
            setWindowOpenHandler: (h: (d: { url: string }) => { action: 'deny' | 'allow' }) => { openHandler = h; },
            on: (event: 'will-navigate', h: (e: { preventDefault(): void }, url: string) => void) => { if (event === 'will-navigate') navigate = h; },
        };
        guardWindowLinks(contents, (url) => { opened.push(url); });
        return { opened, open: (url: string) => openHandler!({ url }), navigate: (url: string) => { let prevented = false; navigate!({ preventDefault: () => { prevented = true; } }, url); return prevented; } };
    };

    it('a new-window link: http(s) to the browser, anything else nowhere; Genie never opens a window for it', () => {
        const r = rig();
        expect(r.open('https://github.com/acme/app/issues/1')).toEqual({ action: 'deny' });
        expect(r.open('file:///etc/passwd')).toEqual({ action: 'deny' });
        expect(r.opened).toEqual(['https://github.com/acme/app/issues/1']);
    });

    it('navigating away from Genie is stopped, http(s) goes to the browser; Genie’s own page is left alone (CONTROL)', () => {
        const r = rig();
        expect(r.navigate('https://example.com/')).toBe(true);
        expect(r.navigate('javascript:alert(1)')).toBe(true);
        expect(r.opened).toEqual(['https://example.com/']);
        expect(r.navigate('file:///app/index.html#genie://settings')).toBe(false);
    });
});

describe('the wiring', () => {
    it('every Genie window is guarded — main, Take Over, the file panel, the flow editor (COUNTED: four)', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main.match(/new BrowserWindow\(/g)).toHaveLength(4);
        expect(main.match(/guardWindowLinks\(win\.webContents, \(url\) => \{ void shell\.openExternal\(url\)\.catch\(\(\) => \{\}\); \}\);/g)).toHaveLength(4);
    });

    it('a terminal’s URL is clickable and goes the same way: window.open, which the guard sends to the browser', () => {
        const pane = readFileSync('src/renderer/components/TerminalPane.tsx', 'utf8');
        // fancy-term 0.8.0's `links.url` (Tynn #763; was 0.7.0's onLinkActivate).
        expect(pane).toMatch(/url: \(url\) => \{ if \(\/\^https\?:\/i\.test\(url\)\) window\.open\(url, '_blank', 'noopener'\); \},/);
        const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
        expect(pkg.dependencies['@particle-academy/fancy-term']).toBe('^0.8.0');
    });
});
