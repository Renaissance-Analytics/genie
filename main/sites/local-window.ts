import { BrowserWindow } from 'electron';

/**
 * A Genie-owned browser window for a LOCAL `.gen` dev site. Opens the site's
 * REAL loopback URL (e.g. `https://tynn.test`) — locally the OS already resolves
 * and trusts the dev cert, so no `.gen` proxy / session-CA is needed (that stack
 * exists only for the REMOTE case, where the peer can't resolve the loopback
 * name). No Genie preload is attached: the window loads third-party dev-site
 * content and must never receive this machine's IPC bridge.
 *
 * Re-opening the same URL focuses the existing window instead of stacking.
 */
const windows = new Map<string, BrowserWindow>();

export function openLocalSiteWindow(url: string, label: string): { ok: boolean; error?: string } {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, error: 'Invalid site URL.' };
    }
    // Only ever open a loopback-served dev site — never an arbitrary URL handed
    // in. http/https only (no file:, etc.).
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'Only http/https dev sites can be opened.' };
    }

    const existing = windows.get(url);
    if (existing && !existing.isDestroyed()) {
        existing.show();
        existing.focus();
        return { ok: true };
    }

    const win = new BrowserWindow({
        width: 1200,
        height: 820,
        minWidth: 480,
        minHeight: 360,
        show: false,
        title: `Genie — ${label}`,
        backgroundColor: '#0a0a0c',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // NO preload — never expose Genie's bridge to dev-site content.
        },
    });
    windows.set(url, win);
    win.on('closed', () => windows.delete(url));
    win.once('ready-to-show', () => win.show());
    void win.loadURL(url);
    return { ok: true };
}
