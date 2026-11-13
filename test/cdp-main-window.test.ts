import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isHostWaitWindow, isMainWindow, mainWindow } from '../scripts/cdp-main-window.mjs';

/*
 * THE ROWS ATTACH TO GENIE'S MAIN WINDOW, NEVER TO "THE FIRST PAGE" (Tynn #692, after #1867). #1867 opens a second window
 * at start, "Starting Genie's host…" (host-wait.html, its own preload, no window.genie.snapshot). A row that took the first
 * page target could attach to it: no-pty found no bridge, trust-step waited on a page that closed. One picker, by URL.
 */
const t = (url: string, type = 'page') => ({ type, url, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${url.length}` });
// Genie's windows load from http://genie.localhost:<port> (Tynn #683).
const MAIN = 'http://genie.localhost:24567/index.html';
const WAIT = 'http://genie.localhost:24567/host-wait.html';

describe('the main window, picked by its URL', () => {
    it('the wait window listed first does not win; the main window does, whatever the order', () => {
        expect(mainWindow([t(WAIT), t(MAIN)])?.url).toBe(MAIN);
        expect(mainWindow([t(MAIN), t(WAIT)])?.url).toBe(MAIN);
        expect(isHostWaitWindow(t(WAIT))).toBe(true);
        expect(isMainWindow(t(WAIT))).toBe(false);
    });

    it('a main window on any of its own routes is the main window; a window bound to one thing is not', () => {
        for (const route of ['', '#genie://dashboard', '#genie://omarchy-test/workspace/tynn?view=tab:door', '#genie://settings', '#genie://agent/agent_1'])
            expect(isMainWindow(t(MAIN + route)), route).toBe(true);
        for (const route of ['#genie://takeover/term_1', '#genie://omarchy-test/flow/new?workspace=tynn', '#genie://files/tynn'])
            expect(isMainWindow(t(MAIN + route)), route).toBe(false);
    });

    it('nothing else passes: devtools, the browser window, the doctor, a data: page, a target with no socket, a worker', () => {
        for (const other of [t('devtools://devtools/bundled/inspector.html'), t('http://genie.localhost:24567/browser.html'), t('http://genie.localhost:24567/doctor.html'), t('data:text/html,<p>plain</p>'), t(MAIN, 'service_worker')])
            expect(isMainWindow(other), other.url).toBe(false);
        expect(isMainWindow({ type: 'page', url: MAIN })).toBe(false);
        expect(mainWindow([t(WAIT)])).toBeNull();
    });
});

describe('every CI row script picks it through the helper', () => {
    const rows = ['agents-hold-no-pty-cdp', 'smoke-cdp', 'trust-step-cdp', 'crash-cdp-lib', 'local-door-cdp', 'files-watch-cdp', 'chat-drafts-cdp', 'gapp-open-cdp', 'artboard-cdp', 'ui-lag-cdp', 'site-panel-cdp', 'browser-process-cdp', 'layout-sweep', 'host-late-ready-cdp'];
    it.each(rows)('%s imports the picker and never takes the first page target', (name) => {
        const code = readFileSync(`scripts/${name}.mjs`, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        expect(code).toMatch(/from '\.\/cdp-main-window\.mjs'/);
        expect(code).not.toMatch(/\.find\(\(t\) => t\.type === 'page' && t\.webSocketDebuggerUrl\)/);
        expect(code).not.toMatch(/t\.type === 'page' && \/index\\\.html\/\.test\(t\.url\)/);
    });
});

describe("Genie's own page, by one rule (Tynn #683)", () => {
    it('matches http://genie.localhost:<port>/<page>.html and the built file it replaced; nothing else', async () => {
        const { isGeniePage, geniePageSource } = await import('../scripts/cdp-main-window.mjs');
        for (const url of ['http://genie.localhost:24567/index.html', 'http://genie.localhost:1/index.html#genie://dashboard', 'http://genie.localhost:1/index.html?remote=x',
            'file:///C:/Genie/resources/app.asar/dist/renderer/index.html', 'file:///home/genie/work/genie/dist/renderer/index.html#genie://files/tynn'])
            expect(isGeniePage(url), url).toBe(true);
        for (const url of ['http://genie.localhost:1/host-wait.html', 'http://localhost:1/index.html', 'http://evil.example/index.html', 'https://genie.localhost:1/index.html',
            'http://genie.localhost:1/index.htmlx', 'https://com-example-realapp.apps.gen/app/index.html', 'file:///x/app/index.html', 'data:text/html,index.html', '', undefined])
            expect(isGeniePage(url), String(url)).toBe(false);
        expect(isGeniePage('http://genie.localhost:9/question.html', 'question')).toBe(true);
        // The source is what a row builds inside Electron's main: the same rule there.
        expect(new RegExp(geniePageSource('index')).test('http://genie.localhost:24567/index.html#genie://flow/f1')).toBe(true);
    });

    it('no CI script finds Genie\'s page by a bare index.html or renderer path of its own', () => {
        const dir = 'scripts';
        const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.mjs') && !f.endsWith('cdp-main-window.mjs'));
        const own = files.filter((f) => /\/index\\+\.html\/\.test\(|renderer\[\\+\/\]index/.test(readFileSync(`${dir}/${f}`, 'utf8')));
        expect(own).toEqual([]);
    });
});
