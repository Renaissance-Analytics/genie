import { WebContentsView, session, type BrowserWindow } from 'electron';
import { certificateVerdict, genProxyConfig } from '../core/browser-origins.js';
import { lazyViewPort, type ViewPort, type ViewHistory } from './browser-pane.js';
import { genCertificateVerifier, type PresentedCertificate } from './browser-trust.js';

/**
 * THE ELECTRON ADAPTER FOR THE BROWSER PANE — the thin half. Everything decidable is in
 * `browser-pane.ts`, `core/browser-origins.ts` and `browser-trust.ts` (tested); this file only touches Electron:
 *
 * - its own `session` partition, so a page the person opens shares no cookies with the app;
 * - S7, each `.gen` site at its own https origin, on THIS session only:
 *   - `ses.setProxy({ mode: 'pac_script', pacScript })` (electronjs.org/docs/latest/api/session#sessetproxyconfig,
 *     ProxyConfig: electronjs.org/docs/latest/api/structures/proxy-config): `*.gen` → the in-app loopback front door,
 *     which tunnels `CONNECT <name>.gen:443` with Genie's leaf; every other host DIRECT. Electron has no per-session
 *     host-resolver API (`--host-resolver-rules` is process-wide and fixed before ready), so the proxy is the resolver;
 *   - `ses.setCertificateVerifyProc` (electronjs.org/docs/latest/api/session#sessetcertificateverifyprocproc): a `.gen`
 *     host is trusted ONLY with a leaf signed by Genie's CA naming that host (0), refused otherwise (-2); any other
 *     host keeps Chromium's own verdict (-3) — except a Genie-signed certificate, which never vouches outside `.gen`;
 * - every window the page tries to open is denied — the pane is one page, not a browser of windows;
 * - no Node, no preload, context isolation on: a page is untrusted content;
 * - back / forward through `webContents.navigationHistory` (Electron 32+), and each committed main-frame navigation
 *   reported with that history.
 *
 * Not unit-tested (Electron-only); its wiring is source-checked (test/browser-origins-wiring.test.ts) and the VM
 * smoke drives it through the real window.
 */

export interface BrowserViewOptions {
    /** The in-app front door's loopback port (compose `frontDoorPort`). */
    readonly frontDoorPort: number;
    /** Genie's CA, PEM — or `null` (no CA): then every `.gen` certificate is refused and nothing else changes. */
    readonly caPem: string | null;
    readonly log?: (line: string) => void;
}

/** The pane's port on this window — created lazily (see `lazyViewPort`), so no second page target exists at boot. */
export function electronBrowserView(window: BrowserWindow, options: BrowserViewOptions): ViewPort {
    return lazyViewPort(() => createElectronView(window, options));
}

function createElectronView(window: BrowserWindow, options: BrowserViewOptions): ViewPort {
    const log = options.log ?? ((line: string) => console.log(line));
    const ses = session.fromPartition('persist:genie-browser');

    const verify = options.caPem !== null
        ? genCertificateVerifier(options.caPem)
        : (presented: PresentedCertificate) => certificateVerdict(presented.hostname, null);
    ses.setCertificateVerifyProc((request, callback) => {
        callback(verify({ hostname: request.hostname, certificatePem: request.certificate.data }));
    });
    // The first page waits for the proxy: a `.gen` load before it would go to DNS, not to the front door.
    const routed = ses.setProxy(genProxyConfig(options.frontDoorPort)).then(async () => {
        // Measured, not assumed: Chromium's own answer for a `.gen` URL and for a web URL under the new config.
        const gen = await ses.resolveProxy('https://example.gen/');
        const web = await ses.resolveProxy('https://example.com/');
        log(`[browser] .gen → ${gen}; web → ${web}`);
        if (gen !== `PROXY 127.0.0.1:${options.frontDoorPort}`) log(`[browser] .gen sites are NOT routed to the front door (Chromium answered ${JSON.stringify(gen)})`);
    });

    const view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.contentView.addChildView(view);
    view.setVisible(false);

    const listeners = new Set<(state: ViewHistory) => void>();
    const report = (url: string) => {
        const history = view.webContents.navigationHistory;
        const state: ViewHistory = { url, canGoBack: history.canGoBack(), canGoForward: history.canGoForward() };
        for (const l of listeners) l(state);
    };
    view.webContents.on('did-navigate', (_event, url) => report(url));
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) report(url); });

    return {
        loadURL: async (url) => {
            await routed;
            await view.webContents.loadURL(url);
        },
        setBounds: (bounds) => view.setBounds(bounds),
        setVisible: (visible) => view.setVisible(visible),
        goBack: () => view.webContents.navigationHistory.goBack(),
        goForward: () => view.webContents.navigationHistory.goForward(),
        reload: () => view.webContents.reload(),
        onNavigated: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}
