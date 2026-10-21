import { describe, expect, it } from 'vitest';
import { browserWindowOptions } from '../src/core/window.js';
import { GenieBrowser, type BrowserSnapshot, type TabViewEvents, type TabViewPort } from '../src/main/genie-browser-window.js';

/**
 * THE GENIE BROWSER WINDOW'S BRAIN (beta.35 item 36, step 1; Genie 1's main/testing-browser/index.ts): the window owns
 * its tabs, one view per tab, the active one shown and the rest hidden, sized into the page area by the device preset;
 * every address goes through the Genie-sites rule, a page's new window becomes a tab, a failed load says so. The
 * Electron views sit behind a port, so this is tested with fakes and the Electron half is wiring.
 */

interface FakeView extends TabViewPort {
    readonly id: string;
    readonly loads: string[];
    bounds: { x: number; y: number; width: number; height: number } | null;
    visible: boolean | null;
    destroyed: boolean;
    readonly events: TabViewEvents;
}

function harness(hosts: string[] = ['tynn.gen', 'moic.gen']) {
    const views: FakeView[] = [];
    const snapshots: BrowserSnapshot[] = [];
    let n = 0;
    const browser = new GenieBrowser({
        enabledHosts: () => hosts,
        newTabId: () => `t${++n}`,
        createView: (id, events) => {
            const v: FakeView = {
                id, loads: [], bounds: null, visible: null, destroyed: false, events,
                load(url) { this.loads.push(url); }, back() {}, forward() {}, reload() {},
                setBounds(b) { this.bounds = b; }, setVisible(on) { this.visible = on; }, destroy() { this.destroyed = true; },
            };
            views.push(v);
            return v;
        },
        push: (s) => snapshots.push(s),
    });
    browser.setPageBounds({ x: 0, y: 80, width: 1200, height: 700 });
    return { browser, views, snapshots, last: () => snapshots[snapshots.length - 1]! };
}

describe('opening a site', () => {
    it('a typed `tynn` opens https://tynn.gen/ in a new active tab, shown, filling the page area', () => {
        const { browser, views, last } = harness();
        expect(browser.open('tynn')).toEqual({ ok: true });
        expect(views).toHaveLength(1);
        expect(views[0]!.loads).toEqual(['https://tynn.gen/']);
        expect(views[0]!.visible).toBe(true);
        expect(views[0]!.bounds).toEqual({ x: 0, y: 80, width: 1200, height: 700 });
        expect(last().active).toBe('t1');
        expect(last().tabs.map((t) => t.url)).toEqual(['https://tynn.gen/']);
    });

    it('anything that is not a Genie site is refused in words, and no view is made', () => {
        const { browser, views } = harness();
        expect(browser.open('https://example.com/')).toEqual({ ok: false, error: 'example.com is not an enabled tunnel on this host.' });
        expect(views).toHaveLength(0);
    });

    it('+ opens the first Genie site in a new tab (Genie 1); with none served it says so and makes nothing', () => {
        const { browser, views } = harness();
        expect(browser.newTab()).toEqual({ ok: true });
        expect(views[0]!.loads).toEqual(['https://tynn.gen/']);
        const empty = harness([]);
        expect(empty.browser.newTab()).toEqual({ ok: false, error: 'No Genie sites are being served.' });
        expect(empty.views).toHaveLength(0);
    });

    it('the sites are read at each open: a site served after the window opened can be visited', () => {
        const hosts = ['tynn.gen'];
        const { browser } = harness(hosts);
        expect(browser.open('moic').ok).toBe(false);
        hosts.push('moic.gen');
        expect(browser.open('moic').ok).toBe(true);
    });
});

describe('the address bar navigates the active tab', () => {
    it('a site loads in the same view; a refusal loads nothing', () => {
        const { browser, views } = harness();
        browser.open('tynn');
        expect(browser.navigate('moic.gen/deals')).toEqual({ ok: true });
        expect(browser.navigate('https://example.com')).toEqual({ ok: false, error: 'example.com is not an enabled tunnel on this host.' });
        expect(views).toHaveLength(1);
        expect(views[0]!.loads).toEqual(['https://tynn.gen/', 'https://moic.gen/deals']);
    });

    it('with no tab open, the address bar opens one', () => {
        const { browser, views } = harness();
        browser.navigate('tynn');
        expect(views).toHaveLength(1);
    });
});

describe('several tabs', () => {
    it('only the active view is shown; closing it destroys its view and shows its neighbour', () => {
        const { browser, views, last } = harness();
        browser.open('tynn');
        browser.open('moic');
        expect(views.map((v) => v.visible)).toEqual([false, true]);
        browser.activate('t1');
        expect(views.map((v) => v.visible)).toEqual([true, false]);
        browser.close('t1');
        expect(views[0]!.destroyed).toBe(true);
        expect(views[1]!.visible).toBe(true);
        expect(last().active).toBe('t2');
    });

    it('a page’s new window (target=_blank) becomes a tab beside it — a Genie site only', () => {
        const { browser, views, last } = harness();
        browser.open('tynn');
        views[0]!.events.openWindow('https://moic.gen/report');
        views[0]!.events.openWindow('https://example.com/');
        expect(views.map((v) => v.loads[0])).toEqual(['https://tynn.gen/', 'https://moic.gen/report']);
        expect(last().active).toBe('t2');
    });
});

describe('what the view reports', () => {
    it('navigation, title, loading and failure reach the chrome; an aborted load (-3) is not a failure', () => {
        const { browser, views, last } = harness();
        browser.open('tynn');
        const ev = views[0]!.events;
        ev.navigated('https://tynn.gen/deals', true, false);
        ev.title('Deals');
        ev.loaded();
        expect(last().tabs[0]).toMatchObject({ url: 'https://tynn.gen/deals', title: 'Deals', loading: false, canGoBack: true, canGoForward: false });
        ev.failed(-3, 'ERR_ABORTED', 'https://tynn.gen/x', true);
        expect(last().tabs[0]!.error).toBeNull();
        ev.failed(-102, 'ERR_CONNECTION_REFUSED', 'https://tynn.gen/', false);
        expect(last().tabs[0]!.error).toBeNull();
        ev.failed(-102, 'ERR_CONNECTION_REFUSED', 'https://tynn.gen/', true);
        expect(last().tabs[0]!.error).toBe("Couldn't load https://tynn.gen/ (ERR_CONNECTION_REFUSED).");
    });

    it('the snapshot carries the presets, the chosen one, and the sites (the chrome’s row of chips)', () => {
        const { browser, last } = harness();
        browser.open('tynn');
        expect(last().presetId).toBe('fit');
        expect(last().presets.map((p) => p.id)).toEqual(['fit', 'desktop', 'laptop', 'tablet', 'mobile']);
        expect(last().sites).toEqual(['tynn.gen', 'moic.gen']);
    });
});

describe('device presets (Genie 1: a fixed viewport pinned to the page area’s corner)', () => {
    it('Mobile 390 sizes the active view 390 x 844, cut to the page area; Fit fills it again', () => {
        const { browser, views, last } = harness();
        browser.open('tynn');
        browser.setPreset('mobile');
        expect(views[0]!.bounds).toEqual({ x: 0, y: 80, width: 390, height: 700 });
        expect(last().presetId).toBe('mobile');
        browser.setPreset('fit');
        expect(views[0]!.bounds).toEqual({ x: 0, y: 80, width: 1200, height: 700 });
    });

    it('the page area’s new size reaches the active view; an unknown preset is Fit', () => {
        const { browser, views } = harness();
        browser.open('tynn');
        browser.setPreset('nope');
        browser.setPageBounds({ x: 0, y: 90.6, width: 999.4, height: 500 });
        expect(views[0]!.bounds).toEqual({ x: 0, y: 91, width: 999, height: 500 });
    });
});

describe('the window (Genie 1’s size, Genie 2’s frame)', () => {
    it('1200 x 820, at least 720 x 480, the title bar hidden — the native buttons over it on Windows and Linux, not on macOS', () => {
        expect(browserWindowOptions('win32')).toEqual({ width: 1200, height: 820, minWidth: 720, minHeight: 480, titleBarStyle: 'hidden', titleBarOverlay: { height: 36, color: '#0a0a0c', symbolColor: '#e4e4e7' } });
        expect(browserWindowOptions('linux').titleBarOverlay).toBeDefined();
        expect(browserWindowOptions('darwin')).toEqual({ width: 1200, height: 820, minWidth: 720, minHeight: 480, titleBarStyle: 'hidden' });
    });
});

describe('CONTROLS', () => {
    it('an unknown tab id changes nothing and pushes nothing', () => {
        const { browser, snapshots } = harness();
        browser.open('tynn');
        const count = snapshots.length;
        browser.activate('zz');
        browser.close('zz');
        expect(snapshots).toHaveLength(count);
    });
});
