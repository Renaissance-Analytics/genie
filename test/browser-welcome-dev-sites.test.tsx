import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { browserReduce, browserTarget, isAllowedBrowserRequest, type BrowserState } from '../src/core/genie-browser.js';
import { classifyNavigation, type GenRoute } from '../src/core/browser-policy.js';
import { GenieBrowser, type BrowserSnapshot, type TabViewEvents, type TabViewPort } from '../src/main/genie-browser-window.js';
import { BrowserPane, type ViewHistory, type ViewPort } from '../src/main/browser-pane.js';
import { applyFeatureControlAction } from '../src/main/feature-controls.js';
import type { FeatureState } from '../src/main/feature-ipc.js';
import { GenieBrowserChrome } from '../src/renderer/components/GenieBrowserChrome.js';
import { BrowserSurface } from '../src/renderer/components/FeatureSurfaces.js';

/**
 * THE GENIE BROWSER OPENS ON A WELCOME PAGE, AND GOES TO DEV SITES ONLY (Tynn #740, #741; client onboarding call,
 * 2026-11-16, transcript 00:30-00:31). The owner: "It defaults to Tynn … This needs to be a welcome screen", and (decided
 * 2026-11-17) Genie's browser opens the workspace's .gen sites, localhost and 127.0.0.1 only; any other address, typed or
 * followed from a link, opens in the person's normal browser, and a short line says so.
 */

const served = new Set(['shop.gen', 'docs.gen']);

describe('where an address goes (core/genie-browser.ts browserTarget)', () => {
    it('CONTROL: a served .gen site opens here, at https', () => {
        expect(browserTarget('shop', served)).toEqual({ url: 'https://shop.gen/' });
        expect(browserTarget('http://docs.gen/a?b=1', served)).toEqual({ url: 'https://docs.gen/a?b=1' });
    });

    it('localhost and 127.0.0.1 open here: scheme and port kept, bare text is http', () => {
        expect(browserTarget('localhost:5173', served)).toEqual({ url: 'http://localhost:5173/' });
        expect(browserTarget('127.0.0.1:3000/a', served)).toEqual({ url: 'http://127.0.0.1:3000/a' });
        expect(browserTarget('http://127.0.0.1:8000/app?x=1', served)).toEqual({ url: 'http://127.0.0.1:8000/app?x=1' });
        expect(browserTarget('https://localhost:8443/', served)).toEqual({ url: 'https://localhost:8443/' });
    });

    it('any other web address goes to the person’s own browser, as written; bare text as https', () => {
        expect(browserTarget('https://example.com/docs?q=1#h', served)).toEqual({ external: 'https://example.com/docs?q=1#h' });
        expect(browserTarget('http://example.org/', served)).toEqual({ external: 'http://example.org/' });
        expect(browserTarget('example.com', served)).toEqual({ external: 'https://example.com/' });
        expect(browserTarget('github.com/x', served)).toEqual({ external: 'https://github.com/x' });
    });

    it('CONTROL: a .gen name nobody serves, and a non-web address, are refused in words and never handed off', () => {
        expect(browserTarget('other.gen', served)).toEqual({ error: 'other.gen is not an enabled tunnel on this host.' });
        for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'data:text/html,x', '']) {
            const t = browserTarget(raw, served);
            expect('error' in t, raw).toBe(true);
        }
    });

    it('CONTROL (another workstation’s window): localhost there is not a dev site, and is not handed off', () => {
        for (const raw of ['localhost:5173', 'http://127.0.0.1:3000/']) expect('error' in browserTarget(raw, served, { loopback: false }), raw).toBe(true);
    });
});

describe('what a page may request (isAllowedBrowserRequest)', () => {
    it('a dev server’s own http and ws traffic on loopback is allowed', () => {
        for (const u of ['http://localhost:5173/src/main.ts', 'ws://localhost:5173/', 'http://127.0.0.1:8000/api']) expect(isAllowedBrowserRequest(u), u).toBe(true);
    });

    it('CONTROL: http and ws anywhere else, and file:, are still cancelled; https still allowed', () => {
        for (const u of ['http://example.com/a.js', 'ws://shop.gen/hmr', 'http://shop.gen/', 'http://localhost.evil.test/', 'file:///C:/x']) expect(isAllowedBrowserRequest(u), u).toBe(false);
        expect(isAllowedBrowserRequest('https://shop.gen/a.js')).toBe(true);
    });
});

describe('the welcome page in the tab model', () => {
    it('welcome: no tab in front, every tab kept; a tab can be brought back', () => {
        const tab = (id: string) => ({ id, url: `https://${id}.gen/`, title: null, loading: false, canGoBack: false, canGoForward: false, error: null });
        const state: BrowserState = { tabs: [tab('shop'), tab('docs')], active: 'docs' };
        const welcome = browserReduce(state, { kind: 'welcome' });
        expect(welcome).toEqual({ tabs: state.tabs, active: null });
        expect(browserReduce(welcome, { kind: 'activate', id: 'shop' }).active).toBe('shop');
    });
});

interface FakeView extends TabViewPort {
    readonly loads: string[];
    visible: boolean | null;
    readonly events: TabViewEvents;
}

function harness(options: { loopback?: boolean } = {}) {
    const views: FakeView[] = [];
    const snapshots: BrowserSnapshot[] = [];
    const opened: string[] = [];
    let n = 0;
    const browser = new GenieBrowser({
        enabledHosts: () => [...served],
        newTabId: () => `t${++n}`,
        createView: (_id, events) => {
            const v: FakeView = { loads: [], visible: null, events, load(url) { this.loads.push(url); }, back() {}, forward() {}, reload() {}, setBounds() {}, setVisible(on) { this.visible = on; }, destroy() {} };
            views.push(v);
            return v;
        },
        push: (s) => snapshots.push(s),
        openExternal: (url) => opened.push(url),
        ...options,
    });
    browser.setPageBounds({ x: 0, y: 80, width: 1200, height: 700 });
    return { browser, views, opened, last: () => browser.snapshot() };
}

describe('the browser window’s brain', () => {
    it('an address off the dev sites opens in the person’s browser: no view, and the host is said; a dev site next clears it', () => {
        const { browser, views, opened, last } = harness();
        expect(browser.open('https://example.com/docs')).toEqual({ ok: true });
        expect(views).toHaveLength(0);
        expect(opened).toEqual(['https://example.com/docs']);
        expect(last().handedOff).toBe('example.com');
        browser.open('shop');
        expect(last().handedOff).toBeNull();
    });

    it('the address bar on a tab: off-site goes out, and the tab stays where it is', () => {
        const { browser, views, opened, last } = harness();
        browser.open('shop');
        expect(browser.navigate('example.com')).toEqual({ ok: true });
        expect(views).toHaveLength(1);
        expect(views[0]!.loads).toEqual(['https://shop.gen/']);
        expect(opened).toEqual(['https://example.com/']);
        expect(last()).toMatchObject({ active: 't1', handedOff: 'example.com' });
    });

    it('a page’s link or new window off the dev sites goes out too', () => {
        const { browser, views, opened, last } = harness();
        browser.open('shop');
        views[0]!.events.external('https://github.com/login');
        views[0]!.events.openWindow('https://docs.example.com/');
        expect(opened).toEqual(['https://github.com/login', 'https://docs.example.com/']);
        expect(views).toHaveLength(1);
        expect(last().handedOff).toBe('docs.example.com');
    });

    it('localhost opens in a tab here', () => {
        const { browser, views, opened } = harness();
        expect(browser.open('localhost:5173')).toEqual({ ok: true });
        expect(views[0]!.loads).toEqual(['http://localhost:5173/']);
        expect(opened).toEqual([]);
    });

    it('CONTROL (another workstation’s window): localhost is refused in words, and nothing opens anywhere', () => {
        const { browser, views, opened } = harness({ loopback: false });
        const r = browser.open('localhost:5173');
        expect(r.ok).toBe(false);
        expect(views).toHaveLength(0);
        expect(opened).toEqual([]);
    });

    it('+ shows the welcome page: no view made, the open tabs kept and hidden', () => {
        const { browser, views, last } = harness();
        browser.open('shop');
        browser.open('docs');
        expect(browser.newTab()).toEqual({ ok: true });
        expect(views).toHaveLength(2);
        expect(last().active).toBeNull();
        expect(last().tabs).toHaveLength(2);
        expect(views.map((v) => v.visible)).toEqual([false, false]);
    });

    it('CONTROL: a .gen site still opens in a tab, and nothing is handed off', () => {
        const { browser, views, opened, last } = harness();
        expect(browser.open('shop')).toEqual({ ok: true });
        expect(views).toHaveLength(1);
        expect(opened).toEqual([]);
        expect(last().handedOff ?? null).toBeNull();
    });
});

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const win = source('../src/main/genie-browser-electron.ts');
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe('the window’s Electron wiring (source)', () => {
    it('a fresh window with no address opens on the welcome page, never the first site', () => {
        expect(count(win, /initialGenUrl\(/g)).toBe(0);
        expect(win).toMatch(/const target = address \?\? null;/);
    });

    it('the session lets a dev server’s loopback traffic through: isAllowedBrowserRequest', () => {
        expect(win).toMatch(/callback\(\{ cancel: !isAllowedBrowserRequest\(details\.url\) \}\)/);
    });

    it('a link off the dev sites is stopped and handed to the brain, which opens the normal browser', () => {
        expect(win).toMatch(/events\.external\(url\)/);
        expect(win).toMatch(/openExternal: \(url\) =>/);
        expect(count(win, /normalizeNavUrl/g)).toBe(0);
    });
});

const presets = [{ id: 'fit', label: 'Fit' }];
const tab = (id: string) => ({ id, url: `https://${id}.gen/`, title: null, loading: false, canGoBack: false, canGoForward: false, error: null });
const snap = (over: Partial<BrowserSnapshot> = {}): BrowserSnapshot => ({ notice: null, tabs: [], active: null, presetId: 'fit', presets, sites: ['shop.gen', 'docs.gen'], siteLabels: { 'shop.gen': 'Shop', 'docs.gen': 'Docs' }, ...over });
const noop = () => {};
const render = (s: BrowserSnapshot) => renderToStaticMarkup(<GenieBrowserChrome onSitesMenu={async () => null} snapshot={s} refusal={null} onNavigate={noop} onOpen={noop} onActivate={noop} onClose={noop} onNewTab={noop} onBack={noop} onForward={noop} onReload={noop} onPreset={noop} />);

describe('the chrome', () => {
    it('welcome: each site a button by its workspace’s name, and the rule in a few words', () => {
        const html = render(snap());
        expect(html).toContain('data-browser-welcome');
        expect(html.match(/data-browser-welcome-site="/g)).toHaveLength(2);
        expect(html).toMatch(/data-browser-welcome-site="shop\.gen"[\s\S]*?Shop/);
        expect(html).toContain('Dev sites only');
    });

    it('welcome with no sites: says how to get one', () => {
        const html = render(snap({ sites: [], siteLabels: {} }));
        expect(html).toContain('data-browser-welcome');
        expect(html).toContain('No sites yet.');
        expect(html).not.toContain('data-browser-welcome-site=');
    });

    it('handed off: the title row says where it went', () => {
        expect(render(snap({ tabs: [tab('shop')], active: 'shop', handedOff: 'example.com' }))).toMatch(/data-browser-handed-off[^>]*>[\s\S]*?example\.com opened in your browser/);
    });

    it('the address field suggests no product: no tynn', () => {
        expect(render(snap())).not.toMatch(/placeholder="[^"]*tynn/i);
    });

    it('CONTROL: with a tab in front, no welcome page', () => {
        expect(render(snap({ tabs: [tab('shop')], active: 'shop' }))).not.toContain('data-browser-welcome');
    });
});

const routes: GenRoute[] = [{ host: 'shop.gen', target: '127.0.0.1:4101' }];

describe('the in-window pane follows the same rule', () => {
    it('classify: an off-site web address is external; bare localhost is http, here', () => {
        expect(classifyNavigation('https://example.com/docs', routes)).toEqual({ kind: 'external', url: 'https://example.com/docs' });
        expect(classifyNavigation('example.com', routes)).toEqual({ kind: 'external', url: 'https://example.com/' });
        expect(classifyNavigation('localhost:5173', routes)).toEqual({ kind: 'web', url: 'http://localhost:5173/' });
    });

    it('CONTROL: classify keeps .gen sites and http loopback as before', () => {
        expect(classifyNavigation('shop.gen', routes)).toMatchObject({ kind: 'site', host: 'shop.gen' });
        expect(classifyNavigation('http://localhost:5173/', routes)).toEqual({ kind: 'web', url: 'http://localhost:5173/' });
        expect(classifyNavigation('http://127.0.0.1:4101/', routes)).toEqual({ kind: 'web', url: 'http://127.0.0.1:4101/' });
    });

    it('browser.navigate off-site: the person’s browser, the pane not moved, the host said', async () => {
        const opened: string[] = [];
        const navigated: string[] = [];
        const next = {} as FeatureState;
        await applyFeatureControlAction({ routes: () => routes }, { kind: 'browser.navigate', url: 'example.com' }, next, {
            openExternal: async (url) => { opened.push(url); },
            browser: { navigate: async (url) => { navigated.push(url); }, back: noop, forward: noop, reload: noop },
        });
        expect(opened).toEqual(['https://example.com/']);
        expect(navigated).toEqual([]);
        expect(next.browserHandedOff).toBe('example.com');
    });

    it('BrowserPane.show off-site: refused, nothing loaded', async () => {
        const loads: string[] = [];
        const view: ViewPort = { loadURL: async (u) => { loads.push(u); }, setBounds: noop, setVisible: noop, goBack: noop, goForward: noop, reload: noop, onNavigated: (_l: (s: ViewHistory) => void) => noop };
        const pane = new BrowserPane(view, () => routes);
        const r = await pane.show('https://example.com/');
        expect(r.ok).toBe(false);
        expect(loads).toEqual([]);
    });

    it('a link in the pane off the dev sites is stopped, and an http(s) one opens in the person’s browser (source)', () => {
        const pane = source('../src/main/electron-browser-view.ts');
        expect(count(pane, /webContents\.on\('will-navigate'/g)).toBe(1);
        expect(pane).toMatch(/if \(nav\.kind === 'site' \|\| nav\.kind === 'no-site' \|\| nav\.kind === 'web'\) return;\s*event\.preventDefault\(\);/);
        expect(pane).toMatch(/shell\.openExternal\(nav\.url\)/);
    });

    it('the pane says where it went, and suggests no product', () => {
        const data = { browser: { url: null, routes, canGoBack: false, canGoForward: false, handedOff: 'example.com' } };
        const html = renderToStaticMarkup(<BrowserSurface data={data as never} onAction={noop} onNavigate={noop} />);
        expect(html).toMatch(/data-browser-handed-off[\s\S]*?example\.com opened in your browser/);
        expect(html).not.toMatch(/placeholder="[^"]*tynn/i);
    });
});
