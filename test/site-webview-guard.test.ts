import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { guardSiteWebviews } from '../src/main/site-webview-guard.js';

/**
 * A SITE PANEL IS A <webview> (the host split, P2b; the owner, 2026-11-03). `webviewTag` is on for the main window only, so
 * everything a renderer could ask of one is main's to decide here (measured on Electron 45.2.2: with no guard, a chosen
 * preload ran, a file:// src loaded, another partition was accepted). The session comes from the site, never the renderer.
 */

const STORE_A = { name: 'store of workspace A' };

function setup(hosts = ['moic.gen']) {
    const contents = new EventEmitter();
    const sessionForHost = vi.fn((host: string) => (host === 'moic.gen' ? STORE_A : null));
    const openInWindow = vi.fn();
    const openExternal = vi.fn();
    const onGuest = vi.fn();
    guardSiteWebviews(contents, { enabledHosts: () => hosts, sessionForHost, openInWindow, openExternal, onGuest });
    const attach = (src: string, prefs: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => {
        const event = { preventDefault: vi.fn() };
        const handed = { src, ...params };
        contents.emit('will-attach-webview', event, prefs, handed);
        return { refused: event.preventDefault.mock.calls.length > 0, prefs, params: handed as Record<string, unknown> };
    };
    const guest = () => {
        const g = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), stop: vi.fn() });
        contents.emit('did-attach-webview', {}, g);
        return g;
    };
    return { attach, guest, sessionForHost, openInWindow, openExternal, onGuest };
}

describe('attaching', () => {
    it('an enabled site gets its workspace\u2019s store, chosen here', () => {
        const { attach, sessionForHost } = setup();
        const { refused, prefs } = attach('https://moic.gen/', { partition: 'persist:someone-elses' });
        expect(refused).toBe(false);
        expect(sessionForHost).toHaveBeenCalledWith('moic.gen');
        expect(prefs.session).toBe(STORE_A);
        expect(prefs.partition).toBeUndefined();
    });

    it('anything else is refused and given no store', () => {
        const { attach, sessionForHost } = setup();
        for (const src of ['file:///C:/Genie/index.html', 'https://example.com/', 'http://moic.gen/', 'https://other.gen/']) {
            const { refused, prefs } = attach(src);
            expect(refused).toBe(true);
            expect(prefs.session).toBeUndefined();
        }
        expect(sessionForHost).not.toHaveBeenCalled();
    });

    it('an enabled site with no store is refused, not given a shared one', () => {
        expect(setup(['moic.gen', 'other.gen']).attach('https://other.gen/').refused).toBe(true);
    });

    it('what the renderer asked for is gone either way', () => {
        const { attach } = setup();
        const { prefs, params } = attach('https://moic.gen/', { preload: 'file:///evil.js', nodeIntegration: true, sandbox: false }, { allowpopups: 'on' });
        expect(prefs.preload).toBeUndefined();
        expect(prefs.nodeIntegration).toBe(false);
        expect(prefs.sandbox).toBe(true);
        expect(params.allowpopups).toBeUndefined();
    });
});

describe('once attached', () => {
    it('it is handed on, for agents to drive as they do any page', () => {
        const { guest, onGuest } = setup();
        const g = guest();
        expect(onGuest).toHaveBeenCalledWith(g);
    });

    it('a page\u2019s new window opens in the Genie browser, in the background, and is denied here', () => {
        const { guest, openInWindow } = setup();
        const handler = guest().setWindowOpenHandler.mock.calls[0]![0] as (d: { url: string }) => unknown;
        expect(handler({ url: 'https://moic.gen/x' })).toEqual({ action: 'deny' });
        expect(openInWindow).toHaveBeenCalledWith('https://moic.gen/x', 'background');
    });

    it('a link within the sites goes ahead; a link off them opens in the machine\u2019s browser', () => {
        const { guest, openExternal } = setup();
        const g = guest();
        const inside = { preventDefault: vi.fn() };
        g.emit('will-navigate', inside, 'https://moic.gen/next');
        expect(inside.preventDefault).not.toHaveBeenCalled();
        const off = { preventDefault: vi.fn() };
        g.emit('will-navigate', off, 'https://example.com/');
        expect(off.preventDefault).toHaveBeenCalled();
        expect(openExternal).toHaveBeenCalledWith('https://example.com/');
    });

    it('a non-web link off them opens nothing', () => {
        const { guest, openExternal } = setup();
        const off = { preventDefault: vi.fn() };
        guest().emit('will-navigate', off, 'file:///etc/passwd');
        expect(off.preventDefault).toHaveBeenCalled();
        expect(openExternal).not.toHaveBeenCalled();
    });

    it('a load the renderer starts itself (no will-navigate for those) is stopped off the sites', () => {
        const { guest } = setup();
        const g = guest();
        g.emit('did-start-navigation', { url: 'file:///C:/Genie/index.html', isMainFrame: true });
        expect(g.stop).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: within the sites, and any subframe, is left alone', () => {
        const { guest } = setup();
        const g = guest();
        g.emit('did-start-navigation', { url: 'https://moic.gen/next', isMainFrame: true });
        g.emit('did-start-navigation', { url: 'https://example.com/embed', isMainFrame: false });
        expect(g.stop).not.toHaveBeenCalled();
    });
});
