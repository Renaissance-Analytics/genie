import { describe, expect, it } from 'vitest';
import { BrowserPane, type ViewPort } from '../src/main/browser-pane.js';

/**
 * THE GENIE BROWSER'S PANE — the main-process half: a WebContentsView positioned over the box the
 * renderer draws, navigated only through the browser policy. The Electron view is behind a PORT so
 * this runs with a fake: what matters is which URL is loaded, that a `.gen` name becomes its loopback
 * target with the Host kept for the site, that refused schemes never reach the view, and that the
 * view is hidden — not left showing a stale page — when the route has no url.
 */

function fakeView() {
    const loaded: string[] = [];
    const bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
    const headers: Array<{ host: string; target: string }> = [];
    let visible = false;
    const view: ViewPort = {
        loadURL: async (url) => { loaded.push(url); },
        setBounds: (b) => { bounds.push(b); },
        setVisible: (v) => { visible = v; },
        rewriteHost: (host, target) => { headers.push({ host, target }); },
        clearRewrites: () => { headers.length = 0; },
    };
    return { view, loaded, bounds, headers, visible: () => visible };
}

const routes = () => [{ host: 'tynn.gen', target: '127.0.0.1:4101' }];

describe('navigating', () => {
    it('a web URL loads as written and the view is shown', async () => {
        const f = fakeView();
        const pane = new BrowserPane(f.view, routes);
        const r = await pane.show('https://example.com/docs');
        expect(r).toEqual({ ok: true, url: 'https://example.com/docs' });
        expect(f.loaded).toEqual(['https://example.com/docs']);
        expect(f.visible()).toBe(true);
    });

    it('a .gen site loads its loopback target with a Host rewrite registered for the site, and the address stays the .gen name', async () => {
        const f = fakeView();
        const pane = new BrowserPane(f.view, routes);
        const r = await pane.show('tynn.gen/dashboard');
        expect(r).toEqual({ ok: true, url: 'https://tynn.gen/dashboard' });
        expect(f.loaded).toEqual(['http://127.0.0.1:4101/dashboard']);
        expect(f.headers).toEqual([{ host: 'tynn.gen', target: '127.0.0.1:4101' }]);
    });

    it('a .gen name nobody serves is refused with the name, and nothing loads', async () => {
        const f = fakeView();
        const pane = new BrowserPane(f.view, routes);
        expect(await pane.show('ghost.gen')).toEqual({ ok: false, reason: 'nothing is serving ghost.gen' });
        expect(f.loaded).toEqual([]);
    });

    it('refused schemes never reach the view — COUNTED', async () => {
        const f = fakeView();
        const pane = new BrowserPane(f.view, routes);
        const results = await Promise.all(['file:///etc/passwd', 'javascript:alert(1)', 'genie://deck', 'chrome://settings'].map((u) => pane.show(u)));
        expect(results.filter((r) => !r.ok)).toHaveLength(4);
        expect(f.loaded).toEqual([]);
    });
});

describe('geometry and hiding', () => {
    it('bounds follow the box the renderer reports; with no url the view is hidden, not left on a stale page', async () => {
        const f = fakeView();
        const pane = new BrowserPane(f.view, routes);
        pane.setBounds({ x: 208, y: 92, width: 800, height: 600 });
        expect(f.bounds.at(-1)).toEqual({ x: 208, y: 92, width: 800, height: 600 });
        await pane.show('https://example.com/');
        pane.hide();
        expect(f.visible()).toBe(false);
        expect(pane.current()).toBeNull();
    });
});
