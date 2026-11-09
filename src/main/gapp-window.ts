import type { GAppSession } from './gapp-server.js';

/**
 * THE APP WINDOW (GApps v2, V4, Tynn #569; spec .ai/plans/specs/gapps-v2.md): sealed. Sandboxed, isolated, no Node. It
 * loads its app's own origin and cannot navigate off it or open another window. Its preload (main/gapp-preload.ts) gets
 * the channel and that window's token, and no other credential; closing the window ends its session, so the token dies
 * with it. `create` is Electron's BrowserWindow in the window process, and a fake in a test.
 */
interface AppWindow {
    on(event: 'closed', listener: () => void): unknown;
    loadURL(url: string): Promise<unknown>;
    webContents: {
        on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
        setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): unknown;
    };
}

export function openGAppWindow(session: GAppSession, ports: { create: (options: Record<string, unknown>) => AppWindow; preload: string }): AppWindow {
    const origin = new URL(session.url).origin;
    const win = ports.create({
        ...session.window,
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            preload: ports.preload,
            additionalArguments: [`--genie-app-channel=${session.channel}`, `--genie-app-token=${session.token}`],
        },
    });
    const staysHome = (event: { preventDefault(): void }, url: string) => {
        let target: string | null = null;
        try { target = new URL(url).origin; } catch { /* not a URL: refused below */ }
        if (target !== origin) event.preventDefault();
    };
    win.webContents.on('will-navigate', staysHome);
    win.webContents.on('will-redirect', staysHome);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => session.close());
    void win.loadURL(session.url);
    return win;
}
