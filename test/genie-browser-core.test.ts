import { describe, expect, it } from 'vitest';
import { browserReduce, DEVICE_PRESETS, devicePreset, EMPTY_BROWSER, initialGenUrl, isSecureBrowserUrl, normalizeNavUrl, type BrowserState } from '../src/core/genie-browser.js';

/**
 * THE GENIE BROWSER'S RULES — GENIE 1'S (beta.35 item 36; the owner, 2026-10-21: "The Genie 1 browser was damn near
 * perfect … it's its own window"; FTQ q_227d0bb6: Genie sites ONLY). Genie 1's main/testing-browser/chrome.ts, ported
 * as it was: the device presets, the address rule (a .gen site this workstation serves, or nothing — refused in words),
 * the first page; plus the tab model the window runs on (Genie 1 kept it inside its window module).
 */

describe('the device presets (Genie 1)', () => {
    it('Fit, then the four device widths, in Genie 1’s order and words (COUNTED: five)', () => {
        expect(DEVICE_PRESETS.map((p) => [p.id, p.label, p.width])).toEqual([
            ['fit', 'Fit', null], ['desktop', 'Desktop 1280', 1280], ['laptop', 'Laptop 1024', 1024], ['tablet', 'Tablet 768', 768], ['mobile', 'Mobile 390', 390],
        ]);
        expect(devicePreset('nope').id).toBe('fit');
    });
});

describe('the address bar takes a Genie site, and only that', () => {
    const enabled = new Set(['tynn.gen', 'moic.gen']);
    it('tynn.gen, a bare tynn, a path, http — all to https on the site', () => {
        expect(normalizeNavUrl('tynn.gen', enabled)).toEqual({ url: 'https://tynn.gen/' });
        expect(normalizeNavUrl('tynn', enabled)).toEqual({ url: 'https://tynn.gen/' });
        expect(normalizeNavUrl('https://moic.gen/deals?x=1#a', enabled)).toEqual({ url: 'https://moic.gen/deals?x=1#a' });
        expect(normalizeNavUrl('http://tynn.gen/up', enabled)).toEqual({ url: 'https://tynn.gen/up' });
    });
    it('anything else is refused in Genie 1’s words — the open web included', () => {
        expect(normalizeNavUrl('', enabled)).toEqual({ error: 'Enter an enabled development address.' });
        expect(normalizeNavUrl('https://example.com/', enabled)).toEqual({ error: 'example.com is not an enabled tunnel on this host.' });
        expect(normalizeNavUrl('other.gen', enabled)).toEqual({ error: 'other.gen is not an enabled tunnel on this host.' });
        expect(normalizeNavUrl('http://[::1', enabled)).toEqual({ error: 'That is not a valid address.' });
    });
    it('the first page is the first enabled site, else none (the empty state)', () => {
        expect(initialGenUrl(['tynn.gen', 'moic.gen'])).toBe('https://tynn.gen/');
        expect(initialGenUrl([])).toBeNull();
    });
});

describe('a page’s own requests travel secure only (Genie 1 SECURE_BROWSER_SCHEMES)', () => {
    it('https and wss, and Chromium’s own page-made schemes, pass', () => {
        for (const u of ['https://tynn.gen/app.js', 'wss://tynn.gen/app', 'about:blank', 'data:text/plain,x', 'blob:https://tynn.gen/1', 'devtools://devtools/x']) expect(isSecureBrowserUrl(u), u).toBe(true);
    });
    it('http, ws, file — and what does not parse — are cancelled', () => {
        for (const u of ['http://tynn.gen/app.js', 'ws://tynn.gen/hmr', 'file:///C:/secret.txt', 'ftp://x/', 'not a url']) expect(isSecureBrowserUrl(u), u).toBe(false);
    });
});

describe('the tabs', () => {
    const open = (s: BrowserState, id: string, url: string) => browserReduce(s, { kind: 'open', id, url });
    it('a tab opens active and loading; a page that lands names it; back/forward follow the page', () => {
        let s = open(EMPTY_BROWSER, 't1', 'https://tynn.gen/');
        expect(s.active).toBe('t1');
        expect(s.tabs[0]).toMatchObject({ id: 't1', url: 'https://tynn.gen/', loading: true, title: null, error: null });
        s = browserReduce(s, { kind: 'navigated', id: 't1', url: 'https://tynn.gen/deals', title: 'Deals', canGoBack: true, canGoForward: false });
        s = browserReduce(s, { kind: 'loaded', id: 't1' });
        expect(s.tabs[0]).toMatchObject({ url: 'https://tynn.gen/deals', title: 'Deals', loading: false, canGoBack: true, canGoForward: false });
    });

    it('a page asking for a new window opens a NEW active tab beside its own (Genie 1: _blank → tab)', () => {
        let s = open(EMPTY_BROWSER, 't1', 'https://tynn.gen/');
        s = open(s, 't2', 'https://moic.gen/');
        s = browserReduce(s, { kind: 'activate', id: 't1' });
        s = open(s, 't3', 'https://tynn.gen/report');
        expect(s.tabs.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
        expect(s.active).toBe('t3');
    });

    it('closing the active tab activates its right neighbour, else its left; the last closed leaves none', () => {
        let s = open(open(open(EMPTY_BROWSER, 'a', 'https://tynn.gen/'), 'b', 'https://tynn.gen/'), 'c', 'https://tynn.gen/');
        s = browserReduce(s, { kind: 'activate', id: 'b' });
        s = browserReduce(s, { kind: 'close', id: 'b' });
        expect(s.active).toBe('c');
        s = browserReduce(s, { kind: 'close', id: 'c' });
        expect(s.active).toBe('a');
        s = browserReduce(s, { kind: 'close', id: 'a' });
        expect(s).toEqual(EMPTY_BROWSER);
    });

    it('a load that fails says so on its tab, and the next load clears it', () => {
        let s = open(EMPTY_BROWSER, 't1', 'https://tynn.gen/');
        s = browserReduce(s, { kind: 'failed', id: 't1', url: 'https://tynn.gen/', description: 'ERR_CONNECTION_REFUSED' });
        expect(s.tabs[0]).toMatchObject({ loading: false, error: "Couldn't load https://tynn.gen/ (ERR_CONNECTION_REFUSED)." });
        s = browserReduce(s, { kind: 'loading', id: 't1' });
        expect(s.tabs[0]).toMatchObject({ loading: true, error: null });
    });

    it('CONTROL: an action for a tab that is not there changes nothing', () => {
        const s = open(EMPTY_BROWSER, 't1', 'https://tynn.gen/');
        expect(browserReduce(s, { kind: 'close', id: 'zz' })).toBe(s);
        expect(browserReduce(s, { kind: 'loaded', id: 'zz' })).toBe(s);
    });
});
