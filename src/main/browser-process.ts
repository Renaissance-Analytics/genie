import { app, safeStorage } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeRefusal } from '../core/browser-store.js';
import { BROWSER_LINK_LABEL } from '../core/engine-protocol.js';
import type { BrowserFacts } from './browser-service.js';
import { BrowserCookieBridge } from './browser-cookie-bridge.js';
import { runBrowserLink, type BrowserLinkClient } from './browser-process-link.js';
import { linkToRunningHost } from './engine-launch.js';
import { genieBrowserWindows, rerouteGenieBrowserSession, watchWorkspaceStores, workspaceBrowserSession, type GenieBrowserWindows } from './genie-browser-electron.js';
import { drivablePages, onPagesChanged } from './page-navigation-electron.js';
import { genieRoot, runtimeDir } from './paths.js';
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

// The host's root (P7): started by genie-host with its environment, GENIE_HOME included.
const home = genieRoot();
app.setPath('userData', join(home, 'browser', '.process'));
// A launch flag for the proof (scripts/browser-process-cdp.mjs), as --remote-debugging-port is for the window.
const debugPort = process.argv.find((a) => a.startsWith('--genie-browser-debug-port='))?.split('=')[1];
if (debugPort) app.commandLine.appendSwitch('remote-debugging-port', debugPort);
const NO_WINDOW_LIMIT_MS = 60_000;
/** A route that is no workspace's site (a service's dashboard). */
const SHARED_STORE = '_shared';

export async function runBrowserProcess(): Promise<void> {
    if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
    const here = dirname(fileURLToPath(import.meta.url));
    const log = (line: string): void => { console.log(`[genie-browser] ${line}`); };
    app.on('window-all-closed', () => { app.quit(); });
    await app.whenReady();

    // No store is touched without the key (core/browser-store.ts), and it doesn't come back in a running process.
    const locked = !safeStorage.isEncryptionAvailable();
    let windows: GenieBrowserWindows | null = null;
    let linkedClient: BrowserLinkClient | null = null;
    let hosts: readonly string[] = [];
    let workspaceOf: Readonly<Record<string, string>> = {};
    let opened = false;
    // Started and given nothing to open: not a process left behind.
    setTimeout(() => { if (!opened) app.quit(); }, NO_WINDOW_LIMIT_MS).unref?.();

    let connection: string | null = null;
    let door: { frontDoorPort: number; caPem: string | null } = { frontDoorPort: 0, caPem: null };
    const cookies = new BrowserCookieBridge({
        call: (method, args) => linkedClient?.browserCall(method, args) ?? Promise.resolve(null),
        me: () => connection,
        openStore: (workspaceId) => workspaceBrowserSession({ genieHome: home, workspaceId, side: 'browser', ...door, log }).ses,
    });
    watchWorkspaceStores(cookies);

    /** Another workstation's door, per window key: what its session reads live. */
    const remoteDoors = new Map<string, { port: number; ca: string | null }>();

    const onFacts = (facts: BrowserFacts): void => {
        door = { frontDoorPort: facts.frontDoorPort, caPem: facts.caPem };
        hosts = facts.hosts;
        workspaceOf = facts.workspaceOf;
        if (windows === null) {
            windows = genieBrowserWindows({ here, preload: join(here, 'browser-preload.cjs'), frontDoorPort: facts.frontDoorPort, caPem: facts.caPem, enabledHosts: () => (locked ? [] : hosts), genieHome: home, workspaceOf: (host) => workspaceOf[host] ?? SHARED_STORE, log, onSingleClosed: (panelKey) => { void linkedClient?.browserCall('popBack', [panelKey]).catch(() => {}); } });
        } else {
            rerouteGenieBrowserSession({ frontDoorPort: facts.frontDoorPort, caPem: facts.caPem, log });
        }
        if (locked) windows.setNotice(storeRefusal(process.platform, process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null), true);
    };

    const sayPages = (): void => {
        const pages = drivablePages().map((p) => ({ id: p.id, url: p.url, title: p.title, revision: p.revision() }));
        void linkedClient?.browserCall('pages', [pages]).catch(() => {});
    };
    onPagesChanged(sayPages);

    runBrowserLink({
        linked: (client) => { linkedClient = client; sayPages(); cookies.relinked(); },
        pageCall: (event, client) => {
            const page = drivablePages().find((p) => p.id === event.pageId);
            const answer = page ? page.transport.call(event.method, [...event.args]) : Promise.reject(new Error('that page is gone'));
            void answer.then(
                (value) => client.browserCall('pageReply', [event.requestId, true, value]),
                (error: unknown) => client.browserCall('pageReply', [event.requestId, false, error instanceof Error ? error.message : String(error)]),
            ).catch(() => {});
        },
        connect: async (onLost) => {
            const found = await linkToRunningHost({ runtimeDir: runtimeDir(home) });
            if (found === null) return null;
            // It says it is the browser: the host never forwards a tool or an elevation to this link (Tynn #444).
            const client = new SessionEngineClient({ label: BROWSER_LINK_LABEL, onDisconnected: () => onLost(), log });
            const connected = await client.connect(found.transport, found.token);
            if (!connected.ok) { found.transport.close(); return null; }
            connection = String(await client.browserCall('whoami', []));
            const link: BrowserLinkClient = {
                browserCall: (method, args) => client.browserCall(method, args),
                onBrowserEvent: (listener) => client.onBrowserEvent(listener),
                close: () => client.disconnect(),
            };
            return link;
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        facts: onFacts,
        door: (up) => { if (!locked) windows?.setNotice(up ? null : DOOR_DOWN); },
        open: (url, activation, remote) => {
            opened = true;
            if (remote) remoteDoors.set(remote.key, { port: remote.port, ca: remote.ca });
            // Its door is read live: a reconnect moves it, and the host's CA is known only after its first site is asked for.
            const answer = windows?.open(url ?? undefined, activation, remote ? { key: remote.key, title: remote.title, hosts: remote.hosts, port: () => remoteDoors.get(remote.key)?.port ?? remote.port, ca: () => remoteDoors.get(remote.key)?.ca ?? null } : undefined);
            if (answer && !answer.ok) log(`open refused: ${answer.error}`);
        },
        remoteVia: (key, port, ca) => { if (remoteDoors.has(key)) remoteDoors.set(key, { port, ca }); },
        openSingle: (panelKey, url) => { opened = true; windows?.openSingle(panelKey, url); },
        closeSingle: (panelKey) => { windows?.closeSingle(panelKey); },
        quit: () => { app.quit(); },
        other: (event) => { if (event.kind === 'cookies' || event.kind === 'cookiesWanted') cookies.onEvent(event); },
        log,
    });
}

void runBrowserProcess();
