import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { STORE_LOCKED } from '../src/core/browser-store.js';
import { BrowserCookieBridge } from '../src/main/browser-cookie-bridge.js';
import { GenieBrowserChrome } from '../src/renderer/components/GenieBrowserChrome.js';
import { SitePanel } from '../src/renderer/components/SitePanel.js';
import { siteWebviewLayer } from '../src/renderer/site-webview-layer.js';

/**
 * NO COOKIE STORE IS TOUCHED WHILE THE KEY ISN'T THERE (the host split, P2b). Measured on omarchy-test with the cookie fuse on:
 * a launch with no keyring that opens a store destroys what is in it, for good; one that touches nothing leaves it whole;
 * and availability doesn't update in a running process. So: no store, the words, and a restart as the way out.
 */

const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
const noop = () => {};

describe('the store', () => {
    const fn = () => { const src = strip('src/main/genie-browser-electron.ts'); return src.slice(src.indexOf('export function workspaceBrowserSession')); };

    it('asks before anything else, and throws rather than opening one', () => {
        const body = fn();
        const guard = body.indexOf('safeStorage.isEncryptionAvailable()');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(body.indexOf('session.fromPath('));
        expect(guard).toBeLessThan(body.indexOf('mkdirSync('));
        expect(body).toMatch(/throw new Error\(STORE_LOCKED\)/);
    });

    it('a store already open is handed back without asking again: it opened with the key', () => {
        const body = fn();
        expect(body.indexOf('if (found) return found')).toBeLessThan(body.indexOf('safeStorage.isEncryptionAvailable()'));
    });
});

describe('the words', () => {
    it('say why, that nothing was lost, what to do, and that a restart is needed', () => {
        expect(STORE_LOCKED).toMatch(/keyring/i);
        expect(STORE_LOCKED).toMatch(/safe/i);
        expect(STORE_LOCKED).toMatch(/unlock/i);
        expect(STORE_LOCKED).toMatch(/restart/i);
    });
});

describe('the window', () => {
    it('main says so before a page is tried, and no webview is given a store', () => {
        const src = strip('src/main/site-panels-electron.ts');
        expect(src).toMatch(/isEncryptionAvailable\(\)[\s\S]*?locked: true/);
        expect(src).toMatch(/sessionForHost: \(host\) => \{[\s\S]*?catch \{ return null; \}/);
    });

    it('the layer makes no page when refused, and tells the panel why', async () => {
        const made: string[] = [];
        const doc = { body: { appendChild() {} }, createElement: (tag: string) => { made.push(tag); return { style: {}, setAttribute() {}, appendChild() {}, remove() {} }; } } as never;
        const layer = siteWebviewLayer({ doc, prepare: async () => ({ ok: false, error: STORE_LOCKED, locked: true }) });
        const heard: unknown[] = [];
        layer.onRefused('ws:t:0', (why) => heard.push(why));
        await layer.show('ws:t:0', 'moic.gen', { x: 0, y: 0, width: 10, height: 10 });
        expect(made).not.toContain('webview');
        expect(heard).toEqual([{ error: STORE_LOCKED, locked: true }]);
    });

    it('once allowed again it says the refusal is over', async () => {
        const doc = { body: { appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }) } as never;
        let answer: { ok: true } | { ok: false; error: string; locked?: boolean } = { ok: false, error: 'no' };
        const layer = siteWebviewLayer({ doc, prepare: async () => answer });
        const heard: unknown[] = [];
        layer.onRefused('ws:t:0', (why) => heard.push(why));
        await layer.show('ws:t:0', 'moic.gen', { x: 0, y: 0, width: 10, height: 10 });
        answer = { ok: true };
        await layer.show('ws:t:0', 'moic.gen', { x: 0, y: 0, width: 10, height: 10 });
        expect(heard.at(-1)).toBeNull();
    });

    it('the panel says it in words, with Restart as the way out', () => {
        const live = { panelKey: 'ws:t:0', onBounds: noop, onHide: noop, onReload: noop, onBack: noop, onForward: noop, onState: () => noop, onOpenInWindow: noop, refused: { error: STORE_LOCKED, locked: true }, onRestart: noop };
        const html = renderToStaticMarkup(<SitePanel host="moic.gen" onPick={noop} live={live} />);
        expect(html).toContain('data-site-refused');
        expect(html).toContain(STORE_LOCKED);
        expect(html).toMatch(/<button[^>]*data-site-action="restart"/);
    });

    it('another refusal: the words, and no Restart', () => {
        const live = { panelKey: 'ws:t:0', onBounds: noop, onHide: noop, onReload: noop, onBack: noop, onForward: noop, onState: () => noop, onOpenInWindow: noop, refused: { error: 'moic.gen is not served here' }, onRestart: noop };
        const html = renderToStaticMarkup(<SitePanel host="moic.gen" onPick={noop} live={live} />);
        expect(html).toContain('moic.gen is not served here');
        expect(html).not.toContain('data-site-action="restart"');
    });
});

describe('the browser process', () => {
    it('with no key it offers no sites and says so: it restarts itself, and the window is untouched', () => {
        const src = strip('src/main/browser-process.ts');
        expect(src).toMatch(/isEncryptionAvailable\(\)/);
        expect(src).toMatch(/enabledHosts: \(\) => \(locked \? \[\] : hosts\)/);
        const chrome = strip('src/main/genie-browser-electron.ts');
        expect(chrome).toMatch(/'browser-window:restart', \(event\) => brain\(event\) && restartThisProcess\(\)/);
        expect(chrome).toMatch(/restartThisProcess = \(\): void => \{ app\.relaunch\(\); app\.exit\(0\); \}/);
    });

    it('its chrome offers it beside the notice', () => {
        const snapshot = { notice: STORE_LOCKED, noticeRestart: true, tabs: [], active: null, presetId: 'fit', presets: [], sites: [] };
        const html = renderToStaticMarkup(<GenieBrowserChrome snapshot={snapshot} refusal={null} onNavigate={noop} onOpen={noop} onActivate={noop} onClose={noop} onNewTab={noop} onBack={noop} onForward={noop} onReload={noop} onPreset={noop} onRestart={noop} />);
        expect(html).toMatch(/<button[^>]*data-browser-restart/);
    });
});

describe('the sync', () => {
    it('a cookie for a store it can’t open is dropped, not fatal: nothing is written with no key', () => {
        const openStore = vi.fn(() => { throw new Error(STORE_LOCKED); });
        const bridge = new BrowserCookieBridge({ call: async () => null, me: () => 'me', openStore });
        expect(() => bridge.onEvent({ kind: 'cookies', from: 'other', workspaceId: 'ws', message: { op: 'set', cookie: { name: 'a', value: 'b', domain: 'moic.gen' } } })).not.toThrow();
        expect(openStore).toHaveBeenCalled();
    });
});
