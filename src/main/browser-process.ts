import { app } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserFacts } from './browser-service.js';
import { runBrowserLink, type BrowserLinkClient } from './browser-process-link.js';
import { linkToRunningHost } from './engine-launch.js';
import { genieBrowserWindows, rerouteGenieBrowserSession, type GenieBrowserWindows } from './genie-browser-electron.js';
import { drivablePages, onPagesChanged } from './page-navigation-electron.js';
import { genieHome, runtimeDir } from './paths.js';
import { SessionEngineClient } from './session-engine-client.js';

/**
 * THE GENIE BROWSER AS ITS OWN PROCESS (the host split, P2b; decision 5: "genie browser should be its own process as well,
 * not dependent on the workspace UX"). `--genie-browser` (core/entry-mode.ts), started by the host when something asks to
 * open a site. A client of the host like the window, with its own hello; the two never talk directly.
 *
 * Its own user data folder: two processes cannot share a Chromium profile (measured on Electron 45.2.2).
 * The front door is the window's until P5, so with no window its pages stay up but `.gen` loads fail, and it says so.
 */

export const DOOR_DOWN = 'Genie sites can’t load until Genie’s window is open again. Pages already here stay as they are.';

app.setPath('userData', join(genieHome(), 'browser', '.process'));
// A launch flag for the proof (scripts/browser-process-cdp.mjs), as --remote-debugging-port is for the window.
const debugPort = process.argv.find((a) => a.startsWith('--genie-browser-debug-port='))?.split('=')[1];
if (debugPort) app.commandLine.appendSwitch('remote-debugging-port', debugPort);
const NO_WINDOW_LIMIT_MS = 60_000;

export async function runBrowserProcess(): Promise<void> {
    if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
    const here = dirname(fileURLToPath(import.meta.url));
    const log = (line: string): void => { console.log(`[genie-browser] ${line}`); };
    app.on('window-all-closed', () => { app.quit(); });
    await app.whenReady();

    let windows: GenieBrowserWindows | null = null;
    let linkedClient: BrowserLinkClient | null = null;
    let hosts: readonly string[] = [];
    let opened = false;
    // Started and given nothing to open: not a process left behind.
    setTimeout(() => { if (!opened) app.quit(); }, NO_WINDOW_LIMIT_MS).unref?.();

    const onFacts = (facts: BrowserFacts): void => {
        hosts = facts.hosts;
        if (windows === null) {
            windows = genieBrowserWindows({ here, preload: join(here, 'browser-preload.cjs'), frontDoorPort: facts.frontDoorPort, caPem: facts.caPem, enabledHosts: () => hosts, log, onSingleClosed: (panelKey) => { void linkedClient?.browserCall('popBack', [panelKey]).catch(() => {}); } });
        } else {
            rerouteGenieBrowserSession({ frontDoorPort: facts.frontDoorPort, caPem: facts.caPem, log });
        }
    };

    const sayPages = (): void => {
        const pages = drivablePages().map((p) => ({ id: p.id, url: p.url, title: p.title, revision: p.revision() }));
        void linkedClient?.browserCall('pages', [pages]).catch(() => {});
    };
    onPagesChanged(sayPages);

    runBrowserLink({
        linked: (client) => { linkedClient = client; sayPages(); },
        pageCall: (event, client) => {
            const page = drivablePages().find((p) => p.id === event.pageId);
            const answer = page ? page.transport.call(event.method, [...event.args]) : Promise.reject(new Error('that page is gone'));
            void answer.then(
                (value) => client.browserCall('pageReply', [event.requestId, true, value]),
                (error: unknown) => client.browserCall('pageReply', [event.requestId, false, error instanceof Error ? error.message : String(error)]),
            ).catch(() => {});
        },
        connect: async (onLost) => {
            const found = await linkToRunningHost({ runtimeDir: runtimeDir(genieHome()) });
            if (found === null) return null;
            const client = new SessionEngineClient({ onDisconnected: () => onLost(), log });
            const connected = await client.connect(found.transport, found.token);
            if (!connected.ok) { found.transport.close(); return null; }
            const link: BrowserLinkClient = {
                browserCall: (method, args) => client.browserCall(method, args),
                onBrowserEvent: (listener) => client.onBrowserEvent(listener),
                close: () => client.disconnect(),
            };
            return link;
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        facts: onFacts,
        door: (up) => { windows?.setNotice(up ? null : DOOR_DOWN); },
        open: (url, activation) => {
            opened = true;
            const answer = windows?.open(url ?? undefined, activation);
            if (answer && !answer.ok) log(`open refused: ${answer.error}`);
        },
        openSingle: (panelKey, url) => { opened = true; windows?.openSingle(panelKey, url); },
        closeSingle: (panelKey) => { windows?.closeSingle(panelKey); },
        quit: () => { app.quit(); },
        log,
    });
}

void runBrowserProcess();
