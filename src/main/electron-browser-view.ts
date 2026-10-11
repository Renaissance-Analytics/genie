import { WebContentsView, session, type BrowserWindow } from 'electron';
import { lazyViewPort, type ViewPort } from './browser-pane.js';

/**
 * THE ELECTRON ADAPTER FOR THE BROWSER PANE — the thin half. Everything decidable is in
 * `browser-pane.ts` (tested with a fake); this file only touches Electron:
 *
 * - its own `session` partition, so a page the person opens shares no cookies with the app;
 * - a Host rewrite: requests to a site's loopback target carry `Host: <name>.gen`, registered per
 *   navigation and cleared on the next, so the site sees the name it was created under;
 * - every window the page tries to open is denied — the pane is one page, not a browser of windows;
 * - no Node, no preload, context isolation on: a page is untrusted content.
 *
 * Not unit-tested (Electron-only); the VM smoke drives it through the real window.
 */

/** The pane's port on this window — created lazily (see `lazyViewPort`), so no second page target exists at boot. */
export function electronBrowserView(window: BrowserWindow): ViewPort {
    return lazyViewPort(() => createElectronView(window));
}

function createElectronView(window: BrowserWindow): ViewPort {
    const ses = session.fromPartition('persist:genie-browser');
    const view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.contentView.addChildView(view);
    view.setVisible(false);

    let rewrites: Array<{ host: string; target: string }> = [];
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const hit = rewrites.find((r) => details.url.startsWith(`http://${r.target}/`));
        if (!hit) { callback({ requestHeaders: details.requestHeaders }); return; }
        callback({ requestHeaders: { ...details.requestHeaders, Host: hit.host } });
    });

    return {
        loadURL: (url) => view.webContents.loadURL(url),
        setBounds: (bounds) => view.setBounds(bounds),
        setVisible: (visible) => view.setVisible(visible),
        rewriteHost: (host, target) => { rewrites = [...rewrites.filter((r) => r.host !== host), { host, target }]; },
        clearRewrites: () => { rewrites = []; },
    };
}
