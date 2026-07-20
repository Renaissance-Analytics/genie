/**
 * Minimal Electron stub for Vitest. Vitest runs in Node — `require('electron')`
 * normally points at the Electron binary path, which can't be imported as a
 * module. Aliasing `electron` to this file (see vitest.config.ts) gives every
 * `from 'electron'` import a no-op surface so the module graph loads cleanly.
 *
 * Tests that exercise specific Electron behavior should override locally via
 * `vi.mock('electron', () => ({ ... }))` or by reaching into these exports
 * directly. The defaults below are deliberately inert.
 */

type Handler = (...args: unknown[]) => unknown;

const noop = (): void => {};

export const app = {
    whenReady: (): Promise<void> => Promise.resolve(),
    on: noop,
    once: noop,
    quit: noop,
    setAsDefaultProtocolClient: (): boolean => true,
    isPackaged: false,
    getPath: (): string => '/tmp',
    getAppPath: (): string => '/tmp',
    getVersion: (): string => '0.0.0-test',
    requestSingleInstanceLock: (): boolean => true,
};


export const ipcMain = {
    handle: noop,
    on: noop,
    off: noop,
    removeHandler: noop,
};

export const ipcRenderer = {
    invoke: (): Promise<unknown> => Promise.resolve(undefined),
    on: noop,
    off: noop,
    send: noop,
};

export class BrowserWindow {
    static getAllWindows(): BrowserWindow[] {
        return [];
    }
    webContents = { send: noop, on: noop };
    on = noop;
    once = noop;
    loadURL = noop;
    loadFile = noop;
    show = noop;
    hide = noop;
    focus = noop;
    isDestroyed = (): boolean => false;
}

export class Notification {
    /**
     * Real Electron exposes this static, and main-process code gates every toast
     * on it (`if (!Notification.isSupported()) return`). Without it the stub
     * throws a TypeError mid-call, which in an async catch-block swallows the
     * REST of that block — e.g. the forwarded-answer failure path would skip its
     * recovery re-sync purely because of a gap in the mock.
     */
    static isSupported = (): boolean => false;
    constructor(public opts?: unknown) {}
    show: Handler = noop;
    on: Handler = noop;
}

export const session = {
    defaultSession: {
        cookies: {
            get: async (): Promise<unknown[]> => [],
            set: async (): Promise<void> => {},
            remove: async (): Promise<void> => {},
        },
        fetch: async (): Promise<Response> =>
            new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
    },
    fromPartition: () => ({ cookies: { get: async (): Promise<unknown[]> => [] } }),
};

export const shell = {
    openExternal: async (): Promise<void> => {},
    openPath: async (): Promise<string> => '',
};

export const dialog = {
    showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
        canceled: true,
        filePaths: [],
    }),
    showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> => ({
        canceled: true,
    }),
    showMessageBox: async (): Promise<{ response: number }> => ({ response: 0 }),
};

export const contextBridge = {
    exposeInMainWorld: noop,
};

export const Menu = {
    buildFromTemplate: (template: unknown): unknown => template,
    setApplicationMenu: noop,
};

export const Tray = class {
    constructor(public icon?: unknown) {}
    setContextMenu = noop;
    setToolTip = noop;
    on = noop;
    destroy = noop;
};

export const nativeImage = {
    createFromPath: (p: string): { isEmpty: () => boolean; toPNG: () => Buffer } => ({
        isEmpty: () => true,
        toPNG: () => Buffer.alloc(0),
    }),
};

export const globalShortcut = {
    register: (): boolean => true,
    unregister: noop,
    unregisterAll: noop,
    isRegistered: (): boolean => false,
};

/**
 * safeStorage stub. Defaults to "encryption unavailable" so any module that
 * imports it at load time (e.g. main/terminal/sessions.ts) resolves cleanly.
 * Tests that exercise the encrypted path override `isEncryptionAvailable` and
 * provide a reversible fake cipher (identity round-trip) — see
 * main/terminal/__tests__/sessions.test.ts.
 */
export const safeStorage = {
    isEncryptionAvailable: (): boolean => false,
    encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer): string => b.toString('utf8'),
};
