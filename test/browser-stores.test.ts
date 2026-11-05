import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BrowserService, type BrowserFacts } from '../src/main/browser-service.js';
import { GenieBrowser, type TabViewPort } from '../src/main/genie-browser-window.js';

/**
 * THE BROWSER'S PROCESS, ONE STORE PER WORKSPACE (the host split, P2b; the owner: "keep cookies in .genie/browser/{workspace}").
 * A tab's view has one session for its life, so a page of another workspace's site is a new tab, never the same view
 * with another workspace's login.
 */

function harness(storeOf: (url: string) => string | null) {
    const made: Array<{ id: string; url: string | undefined; loads: string[] }> = [];
    let n = 0;
    const browser = new GenieBrowser({
        enabledHosts: () => ['a.gen', 'a2.gen', 'b.gen'],
        newTabId: () => `t${++n}`,
        storeOf,
        createView: (id, _events, url) => {
            const entry = { id, url, loads: [] as string[] };
            made.push(entry);
            const view: TabViewPort = { load(u) { entry.loads.push(u); }, back() {}, forward() {}, reload() {}, setBounds() {}, setVisible() {}, destroy() {} };
            return view;
        },
        push: () => {},
    });
    return { browser, made };
}
const stores = (url: string) => (url.includes('b.gen') ? 'workspace-b' : 'workspace-a');

describe('a tab and its store', () => {
    it('a view is made knowing the site, so its session can be the site’s workspace’s', () => {
        const { browser, made } = harness(stores);
        browser.open('a.gen');
        expect(made[0]!.url).toBe('https://a.gen/');
    });

    it('the address bar to a site of the same workspace: the same tab', () => {
        const { browser, made } = harness(stores);
        browser.open('a.gen');
        browser.navigate('a2.gen');
        expect(made).toHaveLength(1);
        expect(made[0]!.loads.at(-1)).toBe('https://a2.gen/');
    });

    it('the address bar to another workspace’s site: a new tab, the first left as it is', () => {
        const { browser, made } = harness(stores);
        browser.open('a.gen');
        browser.navigate('b.gen');
        expect(made).toHaveLength(2);
        expect(made[1]!.url).toBe('https://b.gen/');
        expect(made[0]!.loads).toEqual(['https://a.gen/']);
    });
});

describe('what the window publishes', () => {
    const facts = (over: Partial<BrowserFacts> = {}): BrowserFacts => ({ frontDoorPort: 1, caPem: null, hosts: ['a.gen'], workspaceOf: { 'a.gen': 'workspace-a' }, launch: { file: 'g', args: [] }, ...over });

    it('names each site’s workspace', async () => {
        const service = new BrowserService();
        await service.call('publish', [facts()], 'window');
        expect(await service.call('register', [], 'browser')).toMatchObject({ facts: { workspaceOf: { 'a.gen': 'workspace-a' } } });
    });

    it('no such map: refused', async () => {
        await expect(new BrowserService().call('publish', [{ ...facts(), workspaceOf: 'x' }], 'window')).rejects.toThrow(/facts/);
    });
});

describe('the wires', () => {
    const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

    it('the browser’s tabs use the workspace store, side browser, and refuse a site of no workspace', () => {
        const src = strip('src/main/genie-browser-electron.ts');
        expect(src).toMatch(/side: 'browser'/);
        expect(src).toMatch(/options\.workspaceOf\??\.?\(/);
    });

    it('a link to another workspace’s site goes to its own tab, not through this view', () => {
        const src = strip('src/main/genie-browser-electron.ts');
        expect(src).toMatch(/storeOf/);
    });

    it('a new front door reroutes every store', () => {
        const src = strip('src/main/genie-browser-electron.ts');
        const fn = src.slice(src.indexOf('export function rerouteGenieBrowserSession'));
        expect(fn).toMatch(/workspaceStores/);
    });

    it('the window says each site’s workspace', () => {
        expect(strip('src/main/main.ts')).toMatch(/workspaceOf: Object\.fromEntries\(composed\.sites\.list\(\)/);
    });
});
