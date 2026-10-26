import { describe, expect, it } from 'vitest';
import { GenieBrowser, type BrowserSnapshot, type TabViewEvents, type TabViewPort } from '../src/main/genie-browser-window.js';

/**
 * A SITE KEEPS ITS PAGE WHEN YOU GO TO ANOTHER AND COME BACK (genie#1196; the owner, 2026-10-26: "if I am on one site and
 * then go to another site, but then go back to the first site, everything I was doing before switching disappears in
 * that first tab"). Each tab already has its own view — its own DOM and its own history — and switching tabs only hides
 * and shows them. What lost the page was the SITE CHIP: it re-navigated the ACTIVE tab, so A → B → A loaded A afresh in
 * the one tab. Now a chip SHOWS that site's tab — the one already open on that host, not reloaded — or opens one; the
 * address bar still navigates the active tab, as a browser's does.
 */

interface FakeView extends TabViewPort {
    readonly id: string;
    readonly loads: string[];
    readonly calls: string[];
    visible: boolean | null;
    readonly events: TabViewEvents;
}

function harness(hosts: string[] = ['tynn.gen', 'moic.gen', 'kai.gen']) {
    const views: FakeView[] = [];
    const snapshots: BrowserSnapshot[] = [];
    let n = 0;
    const browser = new GenieBrowser({
        enabledHosts: () => hosts,
        newTabId: () => `t${++n}`,
        createView: (id, events) => {
            const v: FakeView = {
                id, loads: [], calls: [], visible: null, events,
                load(url) { this.loads.push(url); }, back() { this.calls.push('back'); }, forward() { this.calls.push('forward'); }, reload() { this.calls.push('reload'); },
                setBounds() {}, setVisible(on) { this.visible = on; }, destroy() {},
            };
            views.push(v);
            return v;
        },
        push: (s) => snapshots.push(s),
    });
    browser.setPageBounds({ x: 0, y: 80, width: 1200, height: 700 });
    return { browser, views, last: () => snapshots[snapshots.length - 1]! };
}

describe('a site chip', () => {
    it('A → B → A: B opens its own tab, and back on A is the SAME tab, shown — not loaded again', () => {
        const { browser, views, last } = harness();
        expect(browser.showSite('https://tynn.gen/')).toEqual({ ok: true });
        // The person works in tynn: it navigates within the site (its own history).
        views[0]!.events.navigated('https://tynn.gen/tasks/42', true, false);
        expect(browser.showSite('https://moic.gen/')).toEqual({ ok: true });
        expect(views).toHaveLength(2);
        expect(last().active).toBe('t2');
        expect(browser.showSite('https://tynn.gen/')).toEqual({ ok: true });
        // Back on tynn: its own tab, shown, with NOTHING loaded — it is where the person left it.
        expect(last().active).toBe('t1');
        expect(views.map((v) => v.visible)).toEqual([true, false]);
        expect(views[0]!.loads).toEqual(['https://tynn.gen/']);
        expect(views[1]!.loads).toEqual(['https://moic.gen/']);
        expect(last().tabs.find((t) => t.id === 't1')!.url).toBe('https://tynn.gen/tasks/42');
    });

    it('the chip for the site already on screen does nothing — no reload of what the person is doing', () => {
        const { browser, views } = harness();
        browser.showSite('https://tynn.gen/');
        browser.showSite('https://tynn.gen/');
        expect(views).toHaveLength(1);
        expect(views[0]!.loads).toEqual(['https://tynn.gen/']);
    });

    it('a site navigated to in an existing tab (the address bar) is found by its CURRENT host', () => {
        const { browser, views, last } = harness();
        browser.showSite('https://tynn.gen/');
        browser.navigate('kai.gen/board'); // the active tab now shows kai
        views[0]!.events.navigated('https://kai.gen/board', true, false);
        browser.showSite('https://moic.gen/');
        browser.showSite('https://kai.gen/');
        expect(last().active).toBe('t1');
        expect(views[0]!.loads).toEqual(['https://tynn.gen/', 'https://kai.gen/board']);
    });

    it('a site that is not a Genie site is refused in words, and nothing is opened or switched', () => {
        const { browser, views, last } = harness();
        browser.showSite('https://tynn.gen/');
        expect(browser.showSite('https://example.com/')).toEqual({ ok: false, error: 'example.com is not an enabled tunnel on this host.' });
        expect(views).toHaveLength(1);
        expect(last().active).toBe('t1');
    });
});

describe('tabs keep their own pages and history', () => {
    it('switching tabs loads nothing; back and forward reach only the active tab', () => {
        const { browser, views } = harness();
        browser.showSite('https://tynn.gen/');
        browser.showSite('https://moic.gen/');
        browser.activate('t1');
        browser.activate('t2');
        expect(views.map((v) => v.loads.length)).toEqual([1, 1]);
        browser.back();
        browser.activate('t1');
        browser.forward();
        expect(views[0]!.calls).toEqual(['forward']);
        expect(views[1]!.calls).toEqual(['back']);
    });
});

describe('the chrome wires the chip to it (comments stripped)', () => {
    it("a site chip calls showSite — never navigate, which re-loads the tab on screen", async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('../src/renderer/browser-main.tsx', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
        expect(src).toMatch(/onOpen=\{\(address\) => answer\(bridge\.showSite\(address\)\)\}/);
        expect(src).not.toMatch(/onOpen=\{\(address\) => answer\(bridge\.navigate\(address\)\)\}/);
    });
});
