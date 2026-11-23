import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { BrowserService, type BrowserEvent } from '../src/main/browser-service.js';
import { browserDoorOf, hostOpensSite } from '../src/main/host-browser.js';
import { WINDOW_ACTIONS } from '../src/main/mcp-host-tools.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4d D2 (Tynn #1046, task #1496). Two things the window did for genie-host, which genie-host now
 * does itself:
 *   1. THE BROWSER'S FACTS. The front door's port, Genie's CA, the hosts and each site's workspace and label came from the
 *      window (main's publishBrowserFacts), and the door was "up" only while that window was connected. genie-host says
 *      them from its own hosting; the window says only how to start the browser (its launch).
 *   2. AN AGENT'S `sites open`. It was a window action (WINDOW_ACTIONS): with no window the agent was refused. It runs in
 *      genie-host: the site opens in the background through genie-host's browser, and every window is told which workspace
 *      to pulse (a `site-opened` tool signal).
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

const DOOR = { frontDoorPort: 4443, caPem: 'CA', hosts: ['shop.gen'], workspaceOf: { 'shop.gen': 'ws_a' }, siteLabels: { 'shop.gen': 'Shop' } };
const LAUNCH = { file: '/opt/genie/genie', args: ['--genie-browser'] };

function heard(service: BrowserService): BrowserEvent[] {
    const events: BrowserEvent[] = [];
    service.onEvent((e) => events.push(e));
    return events;
}

describe('1. genie-host says the browser’s facts itself; the window says only its launch', () => {
    it('the door is up from genie-host alone, with no window ever connected, and a browser that links gets the facts', async () => {
        const service = new BrowserService({});
        const events = heard(service);
        service.door(DOOR);
        expect(events).toContainEqual({ kind: 'door', up: true });
        const answer = await service.call('register', [], 'browser-1') as { facts: Record<string, unknown> | null; doorUp: boolean };
        expect(answer.doorUp).toBe(true);
        expect(answer.facts).toMatchObject(DOOR);
    });

    it('a door change reaches a linked browser; saying the same door again is not news', async () => {
        const service = new BrowserService({});
        service.door(DOOR);
        await service.call('register', [], 'browser-1');
        const events = heard(service);
        service.door({ ...DOOR, hosts: ['shop.gen', 'blog.gen'], workspaceOf: { ...DOOR.workspaceOf, 'blog.gen': 'ws_b' } });
        expect(events.filter((e) => e.kind === 'facts')).toHaveLength(1);
        expect(events.filter((e) => e.kind === 'door')).toEqual([]); // already up
        // The same door again (a registry write that changed no label): nothing is said.
        service.door({ ...DOOR, hosts: ['shop.gen', 'blog.gen'], workspaceOf: { ...DOOR.workspaceOf, 'blog.gen': 'ws_b' } });
        expect(events.filter((e) => e.kind === 'facts')).toHaveLength(1);
    });

    it('the window says only how to start the browser: a publish with front-door facts in it is refused', async () => {
        const service = new BrowserService({});
        await expect(service.call('publish', [{ launch: LAUNCH }], 'window-1')).resolves.toBeNull();
        await expect(service.call('publish', [{ ...DOOR, launch: LAUNCH }], 'window-1')).rejects.toThrow(/how to start the browser/);
        await expect(service.call('publish', [{}], 'window-1')).rejects.toThrow(/how to start the browser/);
    });

    it('the window going does not take genie-host’s door down (CONTROL: the browser going is still heard)', async () => {
        const service = new BrowserService({});
        service.door(DOOR);
        await service.call('publish', [{ launch: LAUNCH }], 'window-1');
        await service.call('register', [], 'browser-1');
        const events = heard(service);
        service.dropped('window-1');
        expect(events.filter((e) => e.kind === 'door')).toEqual([]);
        service.dropped('browser-1');
        expect(events).toContainEqual({ kind: 'browserUp', up: false });
    });

    it('a browser is started only once the window has said how: a site waiting before that starts it then, with that launch', async () => {
        const startBrowser = vi.fn();
        const service = new BrowserService({ startBrowser });
        service.door(DOOR);
        await service.call('open', ['https://shop.gen/', 'background'], 'genie-host');
        expect(startBrowser).not.toHaveBeenCalled();
        await service.call('publish', [{ launch: LAUNCH }], 'window-1');
        expect(startBrowser).toHaveBeenCalledWith(LAUNCH);
    });

    it('the door genie-host says: its port and CA, the routes’ hosts, each site’s workspace by lower-case host, and its label', () => {
        expect(browserDoorOf({
            port: 4443, caPem: 'CA',
            routes: [{ host: 'shop.gen' }, { host: 'Blog.gen' }],
            sites: [{ host: 'shop.gen', workspaceId: 'ws_a', name: 'shop' }, { host: 'Blog.gen', workspaceId: 'ws_b', name: 'blog' }],
            workspaceNames: { ws_a: 'Shop', ws_b: 'Blog' },
        })).toEqual({
            frontDoorPort: 4443, caPem: 'CA',
            hosts: ['shop.gen', 'Blog.gen'],
            workspaceOf: { 'shop.gen': 'ws_a', 'blog.gen': 'ws_b' },
            siteLabels: { 'shop.gen': 'Shop', 'Blog.gen': 'Blog' },
        });
    });

    it('wired: genie-host says its door to its browser; main publishes only its launch, and never on a site change', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/browserService\.door\(browserDoorOf\(\{ \.\.\.view, workspaceNames \}\)\);/);
        // At its start, again on each front-door change it watches, and on a registry write (a workspace's name, its labels).
        expect(host).toMatch(/frontDoorWatch\.subscribe\(\(view\) => \{ sayBrowserDoor\(view\); \}\);/);
        expect(host).toMatch(/if \(event\.store === 'registry'\) sayBrowserDoor\(\);/);
        expect(host).toMatch(/\n\s*sayBrowserDoor\(\);\n\s*\}/);
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/browserCall\('publish', \[\{ launch \}\]\)/);
        // The front door's facts are no longer gathered here for the browser (the panels and sessions still read the watch).
        expect(main).not.toMatch(/siteLabels: browserSiteLabels\(|hosts: frontDoorNow\.routes|workspaceOf: Object\.fromEntries\(/);
    });
});

describe('2. an agent’s `sites open` runs in genie-host, and the window only pulses the workspace', () => {
    const rig = (open: (url: string) => Promise<unknown>) => {
        const signal = vi.fn();
        const opens = hostOpensSite({ open, sites: () => [{ host: 'Shop.gen', workspaceId: 'ws_a' }], signal });
        return { opens, signal };
    };

    it('opens the site in genie-host’s browser and tells the windows to pulse its workspace', async () => {
        const open = vi.fn(async () => ({ browserUp: true }));
        const r = rig(open);
        expect(await r.opens('https://shop.gen/login')).toEqual({ ok: true });
        expect(open).toHaveBeenCalledWith('https://shop.gen/login');
        expect(r.signal).toHaveBeenCalledWith({ kind: 'site-opened', workspaceId: 'ws_a', reason: 'sites open' });
    });

    it('a browser that cannot open says why, and nothing pulses', async () => {
        const r = rig(async () => { throw new Error('this host has no Genie browser'); });
        expect(await r.opens('https://shop.gen/')).toEqual({ ok: false, reason: 'this host has no Genie browser' });
        expect(r.signal).not.toHaveBeenCalled();
    });

    it('an address that is none of this host’s sites opens, and pulses nothing', async () => {
        const r = rig(async () => ({ browserUp: false }));
        expect(await r.opens('https://elsewhere.gen/')).toEqual({ ok: true });
        expect(await r.opens('not a url')).toEqual({ ok: true });
        expect(r.signal).not.toHaveBeenCalled();
    });

    it('`sites open` is no window action: the window runs none of the sites tool', () => {
        expect(WINDOW_ACTIONS.sites?.has('open') ?? false).toBe(false);
    });

    it('wired: genie-host’s sites tool opens through its own browser, and main pulses on the signal and runs no site open', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/openInBrowser: hostOpensSite\(\{/);
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/signal\.kind === 'site-opened' && typeof signal\.workspaceId === 'string'\) showToPerson\(\{ activation: 'background', workspaceId: signal\.workspaceId, reason: 'sites open' \}\)/);
        expect(main).not.toMatch(/agentOpensSite|openInBrowserFor\('background'\)|hosting: composed|workspaceTrusted: /);
        // CONTROL: the person's own click (the Hosting row's Open) still opens through this window, over it.
        expect(main).toMatch(/openInBrowser: openInBrowserFor\('user-gesture'\),/);
    });
});
