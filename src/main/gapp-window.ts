import type { GAppSessionInfo } from '../core/gapps.js';
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
    close(): void;
    webContents: {
        on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
        setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): unknown;
    };
}

/** The window, and its first load: a page that cannot load closes the window and rejects with why. */
export function openGAppWindow(session: GAppSession, ports: { create: (options: Record<string, unknown>) => AppWindow; preload: string }): { window: AppWindow; loaded: Promise<void> } {
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
    return { window: win, loaded: win.loadURL(session.url).then(() => undefined, (error: unknown) => { win.close(); throw error; }) };
}

/**
 * OPENING AN INSTALLED APP (Tynn #595), in the window process: one window per app, an app already open coming to the front.
 * The host mints the session and re-checks the files; the app gets its own browser session, routed before anything loads.
 * With no certificate authority for `.gen` nothing could be trusted, so it says so before asking the host for anything.
 */
export interface GAppWindowsPorts<S> {
    readonly sessions: { open(packageId: string, options?: { preview?: boolean }): Promise<GAppSessionInfo>; close(token: string): void };
    readonly caPem: () => string | null;
    /** The app's own browser session, routed: by its key (`<packageId>`, or `preview:<packageId>` for a preview's own). */
    readonly prepareSession: (key: string) => Promise<S>;
    readonly create: (options: Record<string, unknown>, session: S) => AppWindow;
    readonly preload: string;
    /** An app already open comes to the front (core/window-activation.ts: the person's gesture). */
    readonly bringUp: (window: AppWindow) => void;
}

export class GAppWindows<S> {
    readonly #ports: GAppWindowsPorts<S>;
    readonly #open = new Map<string, AppWindow>();

    constructor(ports: GAppWindowsPorts<S>) {
        this.#ports = ports;
    }

    /** A preview (V8) is a window and a browser session of its own, beside the installed app's. */
    async open(packageId: string, options: { preview?: boolean } = {}): Promise<void> {
        const preview = options.preview === true;
        const key = preview ? `preview:${packageId}` : packageId;
        const running = this.#open.get(key);
        if (running) { this.#ports.bringUp(running); return; }
        if (this.#ports.caPem() === null) throw new Error('This Genie has no certificate for its .gen addresses yet, so the app cannot open safely.');
        const info = preview ? await this.#ports.sessions.open(packageId, { preview: true }) : await this.#ports.sessions.open(packageId);
        let browserSession: S;
        try {
            browserSession = await this.#ports.prepareSession(key);
        } catch (error) {
            this.#ports.sessions.close(info.token);
            throw error;
        }
        const { window, loaded } = openGAppWindow({ ...info, close: () => this.#ports.sessions.close(info.token) }, {
            create: (options) => this.#ports.create(options, browserSession),
            preload: this.#ports.preload,
        });
        this.#open.set(key, window);
        window.on('closed', () => { this.#open.delete(key); });
        await loaded;
    }
}
