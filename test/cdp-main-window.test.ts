import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isHostWaitWindow, isMainWindow, mainWindow } from '../scripts/cdp-main-window.mjs';

/*
 * THE ROWS ATTACH TO GENIE'S MAIN WINDOW, NEVER TO "THE FIRST PAGE" (Tynn #692, after #1867). #1867 opens a second window
 * at start, "Starting Genie's host…" (host-wait.html, its own preload, no window.genie.snapshot). A row that took the first
 * page target could attach to it: no-pty found no bridge, trust-step waited on a page that closed. One picker, by URL.
 */
const t = (url: string, type = 'page') => ({ type, url, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${url.length}` });
const MAIN = 'file:///home/genie/work/genie/dist/renderer/index.html';
const WAIT = 'file:///home/genie/work/genie/dist/renderer/host-wait.html';

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
        for (const other of [t('devtools://devtools/bundled/inspector.html'), t('file:///x/dist/renderer/browser.html'), t('file:///x/dist/renderer/doctor.html'), t('data:text/html,<p>plain</p>'), t(MAIN, 'service_worker')])
            expect(isMainWindow(other), other.url).toBe(false);
        expect(isMainWindow({ type: 'page', url: MAIN })).toBe(false);
        expect(mainWindow([t(WAIT)])).toBeNull();
    });
});

describe('every CI row script picks it through the helper', () => {
    const rows = ['agents-hold-no-pty-cdp', 'smoke-cdp', 'trust-step-cdp', 'crash-cdp-lib', 'local-door-cdp', 'files-watch-cdp', 'chat-drafts-cdp', 'gapp-open-cdp', 'artboard-cdp', 'ui-lag-cdp', 'site-panel-cdp', 'browser-process-cdp', 'layout-sweep'];
    it.each(rows)('%s imports the picker and never takes the first page target', (name) => {
        const code = readFileSync(`scripts/${name}.mjs`, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        expect(code).toMatch(/from '\.\/cdp-main-window\.mjs'/);
        expect(code).not.toMatch(/\.find\(\(t\) => t\.type === 'page' && t\.webSocketDebuggerUrl\)/);
        expect(code).not.toMatch(/t\.type === 'page' && \/index\\\.html\/\.test\(t\.url\)/);
    });
});
