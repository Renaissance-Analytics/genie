import { describe, expect, it } from 'vitest';
import { BrowserPane, lazyViewPort, type PaneState, type ViewHistory, type ViewPort } from '../src/main/browser-pane.js';

/**
 * THE GENIE BROWSER'S PANE — the main-process half: a WebContentsView positioned over the box the
 * renderer draws, navigated only through the browser policy. The Electron view is behind a PORT so
 * this runs with a fake: what matters is which URL is loaded — for a `.gen` site its OWN https origin
 * (S7), never its loopback target — that refused schemes never reach the view, that back / forward /
 * reload are the view's own history, that the address is what the view REPORTS, and that the view is
 * hidden — not left showing a stale page — when the route has no url.
 */

function fakeView() {
    const loaded: string[] = [];
    const bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
    const calls: string[] = [];
    const listeners = new Set<(s: ViewHistory) => void>();
    let visible = false;
    const view: ViewPort = {
        loadURL: async (url) => { loaded.push(url); },
        setBounds: (b) => { bounds.push(b); },
        setVisible: (v) => { visible = v; },
        goBack: () => { calls.push('back'); },
        goForward: () => { calls.push('forward'); },
        reload: () => { calls.push('reload'); },
        onNavigated: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
    const navigated = (s: ViewHistory) => { for (const l of listeners) l(s); };
    return { view, loaded, bounds, calls, navigated, visible: () => visible };
}

const routes = () => [{ host: 'tynn.gen', target: '127.0.0.1:4101' }, { host: 'site-b.gen', target: '127.0.0.1:4102' }];

describe('navigating', () => {
    it('a web URL loads as written and the view is shown', async () => {
        const f = fakeView();
        const pane = new BrowserPane(f.view, routes);
        const r = await pane.show('https://example.com/docs');
        expect(r).toEqual({ ok: true, url: 'https://example.com/docs' });
        expect(f.loaded).toEqual(['https://example.com/docs']);
        expect(f.visible()).toBe(true);
    });

    it('a .gen site loads at ITS OWN https origin — the URL loaded IS the address; its loopback target is never loaded', async () => {
        const f = fakeView();
        const pane = new BrowserPane(f.view, routes);
        const r = await pane.show('tynn.gen/dashboard');
        expect(r).toEqual({ ok: true, url: 'https://tynn.gen/dashboard' });
        expect(f.loaded).toEqual(['https://tynn.gen/dashboard']);
        expect(f.loaded.filter((u) => u.includes('127.0.0.1'))).toHaveLength(0);
        expect(pane.current()).toBe('https://tynn.gen/dashboard');
    });

    it('two sites load at two different hosts (separate cookie jars)', async () => {
        const f = fakeView();
        const pane = new BrowserPane(f.view, routes);
        await pane.show('tynn.gen');
        await pane.show('site-b.gen');
        expect(f.loaded.map((u) => new URL(u).hostname)).toEqual(['tynn.gen', 'site-b.gen']);
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

describe('history and the address the view reports', () => {
    it('what the view reports (a redirect) is the address — the pane does not overwrite it with what was asked for', async () => {
        const f = fakeView();
        f.view.loadURL = async (url) => { f.loaded.push(url); f.navigated({ url: 'https://tynn.gen/login', canGoBack: false, canGoForward: false }); };
        const pane = new BrowserPane(f.view, routes);
        await pane.show('tynn.gen/dashboard');
        expect(pane.current()).toBe('https://tynn.gen/login');
    });

    it('back / forward reach the view only when the view says there is history; reload only with a page — counted', async () => {
        const f = fakeView();
        const pane = new BrowserPane(f.view, routes);
        pane.back();
        pane.forward();
        pane.reload();
        expect(f.calls).toEqual([]);
        await pane.show('tynn.gen');
        f.navigated({ url: 'https://tynn.gen/b', canGoBack: true, canGoForward: false });
        pane.back();
        pane.forward();
        pane.reload();
        expect(f.calls).toEqual(['back', 'reload']);
        f.navigated({ url: 'https://tynn.gen/', canGoBack: false, canGoForward: true });
        pane.forward();
        expect(f.calls).toEqual(['back', 'reload', 'forward']);
    });

    it('listeners hear each change once, with the history flags; a repeat report is not a change', async () => {
        const f = fakeView();
        const pane = new BrowserPane(f.view, routes);
        const heard: PaneState[] = [];
        pane.onChange((s) => heard.push(s));
        f.navigated({ url: 'https://tynn.gen/', canGoBack: false, canGoForward: false });
        f.navigated({ url: 'https://tynn.gen/', canGoBack: false, canGoForward: false });
        f.navigated({ url: 'https://example.com/', canGoBack: true, canGoForward: false });
        expect(heard).toEqual([
            { url: 'https://tynn.gen/', canGoBack: false, canGoForward: false },
            { url: 'https://example.com/', canGoBack: true, canGoForward: false },
        ]);
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

describe('the view is created LAZILY', () => {
    /**
     * CI's real-window smokes attach to the first `type: "page"` CDP target. A WebContentsView created
     * at boot is a second page target (about:blank) that can be found first — PR #43's smoke hung on it
     * for five minutes. So the view does not exist until the browser surface first shows a URL;
     * bounds and visibility set earlier are kept and applied on creation.
     */
    it('nothing is created until the first loadURL; bounds/visibility set earlier are applied on creation; navigation reports reach listeners registered before', async () => {
        let created = 0;
        const f = fakeView();
        const port = lazyViewPort(() => { created += 1; return f.view; });
        const heard: string[] = [];
        port.onNavigated((s) => heard.push(s.url));
        port.setBounds({ x: 1, y: 2, width: 3, height: 4 });
        port.setVisible(false);
        port.goBack();
        port.reload();
        expect(created).toBe(0);
        await port.loadURL('https://tynn.gen/');
        expect(created).toBe(1);
        expect(f.bounds).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
        expect(f.loaded).toEqual(['https://tynn.gen/']);
        expect(f.calls).toEqual([]);
        f.navigated({ url: 'https://tynn.gen/', canGoBack: false, canGoForward: false });
        expect(heard).toEqual(['https://tynn.gen/']);
        await port.loadURL('https://tynn.gen/x');
        expect(created).toBe(1);
    });

    it('hiding before creation creates nothing — a pane nobody opened leaves no target behind', () => {
        let created = 0;
        const port = lazyViewPort(() => { created += 1; return fakeView().view; });
        new BrowserPane(port, routes);
        port.setVisible(false);
        port.goForward();
        expect(created).toBe(0);
    });
});
