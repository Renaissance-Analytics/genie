import { BrowserWindow, WebContentsView, ipcMain, session, shell, type IpcMainInvokeEvent, type Session } from 'electron';
import { join } from 'node:path';
import { certificateVerdict, genProxyConfig } from '../core/browser-origins.js';
import { initialGenUrl, isSecureBrowserUrl, normalizeNavUrl } from '../core/genie-browser.js';
import { browserWindowOptions, overlayColorsOk, TITLE_BAR_HEIGHT } from '../core/window.js';
import { genieWindowIcon } from './app-identity.js';
import { genCertificateVerifier, type PresentedCertificate } from './browser-trust.js';
import { GenieBrowser, type TabViewEvents, type TabViewPort } from './genie-browser-window.js';

/**
 * THE GENIE BROWSER WINDOW — the Electron half (beta.35 item 36; Genie 1's main/testing-browser/index.ts). Everything
 * decidable is in genie-browser-window.ts and core/genie-browser.ts (tested); this file only touches Electron, and its
 * load-bearing lines are source-checked (test/genie-browser-electron-wiring.test.ts):
 *
 * - ONE window for this workstation's sites (another workstation's is step 4), 1200 x 820, its title bar hidden — the
 *   chrome (browser.html, its own preload) owns the top, the native buttons drawn over it on Windows and Linux;
 * - its OWN session: `.gen` routed to Genie's front door (the PAC from core), a `.gen` certificate trusted only when
 *   Genie's CA signed it for that name, and every request a page makes cancelled unless it travels secure (Genie 1);
 * - a WebContentsView per tab, isolated from Node with NO preload — and NOT sandboxed: a sandboxed child view never
 *   receives its renderer's start-up data and the page draws blank (electron#44897; Genie 1 site-view.ts);
 * - a page's new window goes to the brain (a tab, for a Genie site) and is denied; a link off the Genie sites opens in
 *   the machine's browser instead of loading here.
 */

export interface GenieBrowserWindowOptions {
    /** The main bundle's directory (the renderer's files are beside it). */
    readonly here: string;
    readonly preload: string;
    /** The in-app front door's loopback port (compose `frontDoorPort`). */
    readonly frontDoorPort: number;
    /** Genie's CA, PEM, or `null` (then every `.gen` certificate is refused). */
    readonly caPem: string | null;
    /** The `.gen` hosts this workstation serves, now. */
    readonly enabledHosts: () => readonly string[];
    readonly log?: (line: string) => void;
}

/**
 * THE GENIE BROWSER'S SESSION, made once for the process and shared by the window's tabs and the workspaces' live site
 * panels (site-panels-electron.ts): `.gen` routed to the front door, a `.gen` certificate trusted only when Genie's CA
 * signed it for that name, every request a page makes cancelled unless it travels secure. Its routing is awaited by every
 * page load (a `.gen` load before it would go to DNS).
 */
let sharedSession: { ses: Session; routed: Promise<void> } | null = null;
export function genieBrowserSession(options: { frontDoorPort: number; caPem: string | null; log?: (line: string) => void }): { ses: Session; routed: Promise<void> } {
    if (sharedSession) return sharedSession;
    const log = options.log ?? ((line: string) => console.log(line));
    const ses = session.fromPartition('persist:genie-browser-window');
    const verify = options.caPem !== null
        ? genCertificateVerifier(options.caPem)
        : (presented: PresentedCertificate) => certificateVerdict(presented.hostname, null);
    ses.setCertificateVerifyProc((request, callback) => {
        callback(verify({ hostname: request.hostname, certificatePem: request.certificate.data }));
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !isSecureBrowserUrl(details.url) });
    });
    const routed = ses.setProxy(genProxyConfig(options.frontDoorPort)).then(async () => {
        const gen = await ses.resolveProxy('https://example.gen/');
        if (gen !== `PROXY 127.0.0.1:${options.frontDoorPort}`) log(`[browser-window] .gen sites are NOT routed to the front door (Chromium answered ${JSON.stringify(gen)})`);
    });
    sharedSession = { ses, routed };
    return sharedSession;
}

export interface GenieBrowserWindows {
    /** Bring the window up — made if it is not open — with `address` in a new tab; no address: the first site, once. */
    open(address?: string): { ok: true } | { ok: false; error: string };
}

const NOT_OURS = { ok: false as const, error: 'this is not the Genie browser window' };

export function genieBrowserWindows(options: GenieBrowserWindowOptions): GenieBrowserWindows {
    const log = options.log ?? ((line: string) => console.log(line));
    let win: BrowserWindow | null = null;
    let browser: GenieBrowser | null = null;
    let seq = 0;

    // The chrome's calls, registered once; answered only for the browser window's own chrome.
    const brain = (event: IpcMainInvokeEvent): GenieBrowser | null => (win && !win.isDestroyed() && event.sender === win.webContents ? browser : null);
    ipcMain.handle('browser-window:state', (event) => brain(event)?.snapshot() ?? null);
    ipcMain.handle('browser-window:navigate', (event, address: unknown) => brain(event)?.navigate(String(address ?? '')) ?? NOT_OURS);
    ipcMain.handle('browser-window:open', (event, address: unknown) => brain(event)?.open(String(address ?? '')) ?? NOT_OURS);
    ipcMain.handle('browser-window:new-tab', (event) => brain(event)?.newTab() ?? NOT_OURS);
    ipcMain.handle('browser-window:activate', (event, id: unknown) => brain(event)?.activate(String(id)));
    ipcMain.handle('browser-window:close', (event, id: unknown) => brain(event)?.close(String(id)));
    ipcMain.handle('browser-window:back', (event) => brain(event)?.back());
    ipcMain.handle('browser-window:forward', (event) => brain(event)?.forward());
    ipcMain.handle('browser-window:reload', (event) => brain(event)?.reload());
    ipcMain.handle('browser-window:preset', (event, id: unknown) => brain(event)?.setPreset(String(id)));
    ipcMain.handle('browser-window:bounds', (event, raw: unknown) => {
        const b = brain(event);
        const r = raw as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
        if (!b || !r || [r.x, r.y, r.width, r.height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return;
        b.setPageBounds({ x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number });
    });
    ipcMain.handle('browser-window:overlay-colors', (event, color: unknown, symbolColor: unknown) => {
        const b = brain(event);
        if (!b || !win || process.platform === 'darwin' || !overlayColorsOk(color, symbolColor)) return false;
        win.setTitleBarOverlay({ color: color as string, symbolColor: symbolColor as string, height: TITLE_BAR_HEIGHT });
        return true;
    });

    const ensureSession = () => genieBrowserSession({ frontDoorPort: options.frontDoorPort, caPem: options.caPem, log });

    const createView = (window: BrowserWindow, events: TabViewEvents): TabViewPort => {
        const { ses, routed } = ensureSession();
        const view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: false } });
        const wc = view.webContents;
        view.setVisible(false);
        window.contentView.addChildView(view);
        const history = () => wc.navigationHistory;
        wc.on('did-navigate', (_e, url) => events.navigated(url, history().canGoBack(), history().canGoForward()));
        wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) events.navigated(url, history().canGoBack(), history().canGoForward()); });
        wc.on('page-title-updated', (_e, title) => events.title(title));
        wc.on('did-start-loading', () => events.loading());
        wc.on('did-stop-loading', () => events.loaded());
        wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => events.failed(code, description, url, isMainFrame));
        wc.setWindowOpenHandler(({ url }) => {
            events.openWindow(url);
            return { action: 'deny' };
        });
        // A link off the Genie sites: the machine's browser (http(s) only), never this window.
        wc.on('will-navigate', (event, url) => {
            if ('url' in normalizeNavUrl(url, new Set(options.enabledHosts()))) return;
            event.preventDefault();
            if (/^https?:/i.test(url)) void shell.openExternal(url).catch(() => {});
        });
        return {
            load: (url) => {
                void (async () => {
                    await routed;
                    await view.webContents.loadURL(url);
                })().catch(() => {});
            },
            back: () => history().goBack(),
            forward: () => history().goForward(),
            reload: () => wc.reload(),
            setBounds: (bounds) => view.setBounds(bounds),
            setVisible: (visible) => view.setVisible(visible),
            destroy: () => {
                if (!window.isDestroyed()) window.contentView.removeChildView(view);
                if (!wc.isDestroyed()) wc.close();
            },
        };
    };

    const make = (): { window: BrowserWindow; brain: GenieBrowser } => {
        const window = new BrowserWindow({
            ...browserWindowOptions(process.platform),
            ...genieWindowIcon(options.here),
            title: 'Genie browser',
            backgroundColor: '#0a0a0c',
            show: false,
            webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        const b = new GenieBrowser({
            enabledHosts: options.enabledHosts,
            newTabId: () => `tab-${++seq}`,
            createView: (_id, events) => createView(window, events),
            push: (snapshot) => { if (!window.isDestroyed()) window.webContents.send('browser-window:state', snapshot); },
        });
        // The chrome is Genie's page: it never navigates; a link in it opens in the machine's browser.
        window.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:/i.test(url)) void shell.openExternal(url).catch(() => {});
            return { action: 'deny' };
        });
        window.webContents.on('will-navigate', (event) => event.preventDefault());
        window.once('ready-to-show', () => window.show());
        window.on('closed', () => {
            b.closeAll();
            if (win === window) { win = null; browser = null; }
        });
        void window.loadFile(join(options.here, '../renderer/browser.html'));
        return { window, brain: b };
    };

    return {
        open: (address) => {
            const fresh = win === null || win.isDestroyed();
            if (fresh) {
                const m = make();
                win = m.window;
                browser = m.brain;
            } else {
                if (win!.isMinimized()) win!.restore();
                win!.focus();
            }
            const target = address ?? (fresh ? initialGenUrl(options.enabledHosts()) : null);
            if (target === null) return { ok: true };
            return browser!.open(target);
        },
    };
}
