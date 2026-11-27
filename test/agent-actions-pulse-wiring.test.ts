import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * EVERY AGENT PATH THAT USED TO MOVE THE VIEW NOW PULSES ITS WORKSPACE (genie#1265) — the Electron half, read from
 * source (main.ts is Electron and cannot be composed in a test; the rule itself is core/view-requests.ts). Line comments
 * stripped (CRLF-safe), so prose about `genie:navigate` is no wiring.
 *
 * The paths found: `openFileForUser` broadcast `genie:navigate` to the file's workspace route; `workspaceTabs` rewrote a
 * workspace's tabs with nothing to say where; `sites open` put a site in Genie's browser with nothing on the workspace.
 * The tray, the menus and their Settings… are the person's and still navigate.
 */

const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const main = strip(readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
const preload = strip(readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8'));
const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));
const shell = strip(readFileSync(new URL('../src/renderer/Shell.tsx', import.meta.url), 'utf8'));

describe('main: one door to the window’s view, and it asks who', () => {
    it('nothing in main broadcasts genie:navigate by hand — every request goes through showToPerson (core/view-requests.ts)', () => {
        expect(main).not.toMatch(/broadcast\('genie:navigate'/);
        expect(main).toMatch(/function showToPerson\(request: ViewRequest\): void \{\s*const delivery = viewDelivery\(request\);/);
    });

    it('showToPerson sends each request only to the windows it reaches: a navigation to the MAIN window, never every window (genie#1302)', () => {
        const at = main.indexOf('function showToPerson(');
        const body = main.slice(at, main.indexOf('\n}', at));
        expect(body).not.toMatch(/broadcast\(/);
        expect(body).toMatch(/for \(const w of BrowserWindow\.getAllWindows\(\)\) if \(!w\.isDestroyed\(\) && viewReaches\(delivery, \{ main: w === window \}\)\) w\.webContents\.send\(delivery\.channel, delivery\.payload\);/);
    });

    it('openFileForUser: the file’s workspace pulses with the file; never a navigation, never the person’s activation', () => {
        const port = /openFile: async \(\{ workspaceId, path, line \}\) => \{([^\n]*)\}/.exec(main)?.[1] ?? '';
        expect(port).toMatch(/showToPerson\(\{ activation: 'background', workspaceId, file: path, line, reason: 'openFileForUser' \}\)/);
        expect(port).toMatch(/attractMainWindow\('openFileForUser'\)/);
        expect(port).not.toMatch(/user-gesture|revealMainWindow|genie:navigate/);
    });

    it('workspaceTabs: the tabs are written in place and the workspace pulses', () => {
        const port = /write: \(workspaceId, raw\) => \{([^\n]*)\}/.exec(main)?.[1] ?? '';
        // Written to genie-host over the protocol since Tynn #998 (2g-4b1: window-settings.ts).
        expect(port).toMatch(/settingsNow\.setFor\(workspaceId, 'workspace_tabs', raw\)/);
        expect(port).toMatch(/showToPerson\(\{ activation: 'background', workspaceId, reason: 'workspaceTabs' \}\)/);
    });

    it('sites open: Genie’s browser in the background, in genie-host, and the site’s workspace pulses here on its signal (Tynn #1046 D2)', () => {
        // genie-host opens it (host-browser.ts hostOpensSite, pinned in split-2g4d-d2); this window only pulses.
        expect(main).toMatch(/signal\.kind === 'site-opened' && typeof signal\.workspaceId === 'string'\) showToPerson\(\{ activation: 'background', workspaceId: signal\.workspaceId, reason: 'sites open' \}\)/);
        const host = strip(readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8'));
        expect(host).toMatch(/open: \(url\) => browserService\.call\('open', \[url, 'background'\], 'genie-host'\),/);
        // ...and the browser window keeps the person's tab in front (genie-browser-window.ts `showSite(…, activation)`).
        const browser = strip(readFileSync(new URL('../src/main/genie-browser-electron.ts', import.meta.url), 'utf8'));
        expect(browser).toMatch(/return entry!\.browser\.showSite\(target, activation\);/);
    });

    it('every user-gesture view request sits beside the gesture that revealed the window (tray, menu) — the positive control', () => {
        const gestures = main.split('\n').filter((l) => /showToPerson\(\{ activation: 'user-gesture'/.test(l));
        expect(gestures.length).toBeGreaterThanOrEqual(3);
        for (const line of gestures) expect(line).toMatch(/revealMainWindow\(/);
        // Task Manager is the launcher's tray item since Tynn #1058 L5 (--show genie://hosting?tab=processes): revealed, then shown.
        expect(main).toMatch(/if \(shownAtBoot\) \{ revealMainWindow\('launcher tray'\); showToPerson\(\{ activation: 'user-gesture', route: shownAtBoot, reason: 'launcher tray' \}\); \}/);
    });
});

describe('preload and the window', () => {
    it('preload carries the pulse on its own channel', () => {
        expect(preload).toMatch(/onWorkspacePulse: \(onPulse\) => \{[^]*?ipcRenderer\.on\('genie:workspace-pulse', listener\);[^]*?removeListener\('genie:workspace-pulse', listener\)/);
    });

    it('App: a pulse is kept, never navigated to; the person’s arrival clears it and shows what was opened', () => {
        expect(app).toMatch(/resolvedBridge\?\.onWorkspacePulse\?\.\(\(p\) => setPulses\(\(s\) => pulse\(s, p\)\)\)/);
        // The arrival is read from the ROUTE, so every way the person moves counts: a click, a key, the palette, Back.
        expect(app).toMatch(/useEffect\(\(\) => \{ arriveAt\(route\); \}, \[route\]\);/);
        // Clicking the row of the workspace already on screen is an arrival too (the hash does not change).
        expect(app).toMatch(/const navigate = \(next: string\): void => \{ if \(next === route\) \{ arriveAt\(next\); return; \}/);
        expect(app).toMatch(/pulsingWorkspaces=\{pulsingIds\(pulses\)\}/);
    });

    it('Shell hands the pulse to the rail and the Dashboard', () => {
        expect(shell).toMatch(/<Sidebar[^]*?pulsing=\{pulsingWorkspaces\}/);
        expect(shell).toMatch(/<Dashboard[^]*?pulsing=\{pulsingWorkspaces\}/);
    });
});
