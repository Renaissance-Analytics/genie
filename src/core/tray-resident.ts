/**
 * TRAY-RESIDENT GENIE — the pure half.
 *
 * Genie 1 lived in the tray: closing its window hid it, and the agents and terminals it was running
 * kept running (genie `main/background.ts`, the main window's `close` handler and an empty
 * `window-all-closed`). Genie 2 quit on `window-all-closed`, so the window's X ended every session
 * the person had going — after asking, but asking is not the same as staying.
 *
 * Closing the window HIDES it on Windows and Linux. A quit is only ever asked for: the tray's Quit,
 * the app menu's Quit, or the operating system ending the session. macOS keeps its own convention
 * (the window closes, the app stays in the Dock), which Genie 2 already followed.
 *
 * Two settings ride with it: start minimised (boot without the window) and launch at sign-in
 * (registered with the OS on change and re-applied at every boot, so a moved install is followed).
 */

export type CloseAction = 'hide' | 'close';

/**
 * What the main window's close does. Once a quit is under way the close is real, on every
 * platform — Electron aborts a quit whose windows refuse to close, so hiding here would turn the
 * tray's Quit into a no-op.
 */
export function closeAction(platform: NodeJS.Platform, quitting: boolean): CloseAction {
    if (quitting) return 'close';
    return platform === 'darwin' ? 'close' : 'hide';
}

/** The flag a sign-in launch carries when Genie should come up in the tray only. */
export const HIDDEN_ARG = '--hidden';
/** Genie 1's sign-in flag. Its login entry is still there after the upgrade until Genie 2 rewrites it, and it meant "tray only". */
export const V1_AUTOSTART_ARG = '--autostart';

/** Whether the window is shown when Genie boots. Start minimised, or a launch that asked to be hidden, keeps it in the tray. */
export function showOnBoot(input: { readonly startMinimized: boolean; readonly argv: readonly string[] }): boolean {
    if (input.startMinimized) return false;
    return !input.argv.includes(HIDDEN_ARG) && !input.argv.includes(V1_AUTOSTART_ARG);
}

/** Said once, the first time the window's close hides Genie instead of ending it. */
export const TRAY_NOTICE = {
    title: 'Genie is still running in the tray',
    body: 'Closing the window keeps your agents and terminals running. Open Genie or quit it from the tray icon.',
} as const;

/** The notice is due on a close that HID the window, and only if it was never shown before. */
export function trayNoticeDue(action: CloseAction, alreadyShown: boolean): boolean {
    return action === 'hide' && !alreadyShown;
}

/** What `app.setLoginItemSettings` is given — the subset Genie uses. */
export interface LoginItemSettings {
    readonly openAtLogin: boolean;
    readonly path?: string;
    readonly args?: readonly string[];
}

export type LoginItemPlan =
    | { readonly kind: 'none'; readonly reason: string }
    | { readonly kind: 'login-item'; readonly settings: LoginItemSettings }
    /** Linux: Electron has no login-item API there; a freedesktop autostart entry is the convention (Genie 1 wrote the same file). `content: null` removes it. */
    | { readonly kind: 'desktop-file'; readonly file: string; readonly content: string | null };

export interface LoginItemInput {
    readonly platform: NodeJS.Platform;
    /** A development run is not registered: the entry would point at a build that is gone when the session ends. */
    readonly packaged: boolean;
    readonly launchAtLogin: boolean;
    readonly startMinimized: boolean;
    readonly execPath: string;
    /** `$APPIMAGE` on Linux: an AppImage's `execPath` is a mount that changes every launch. */
    readonly appImage?: string | null;
    /** `$XDG_CONFIG_HOME`, else `~/.config`. */
    readonly configHome: string;
}

/** The autostart entry's file name. Genie 1's — Genie 2 upgrades it in place, so there is one Genie and one entry. */
export const LINUX_AUTOSTART_FILE = 'genie.desktop';

export function linuxAutostartFile(configHome: string): string {
    return `${configHome.replace(/\/+$/, '')}/autostart/${LINUX_AUTOSTART_FILE}`;
}

export function loginItemPlan(input: LoginItemInput): LoginItemPlan {
    if (!input.packaged) return { kind: 'none', reason: 'a development run is never registered to start at sign-in' };
    const args = input.startMinimized ? [HIDDEN_ARG] : [];
    if (input.platform === 'win32') return { kind: 'login-item', settings: { openAtLogin: input.launchAtLogin, path: input.execPath, args } };
    // macOS takes no arguments for a login item; start minimised is read from the setting at boot instead.
    if (input.platform === 'darwin') return { kind: 'login-item', settings: { openAtLogin: input.launchAtLogin } };
    if (input.platform === 'linux') {
        const file = linuxAutostartFile(input.configHome);
        if (!input.launchAtLogin) return { kind: 'desktop-file', file, content: null };
        const exe = input.appImage && input.appImage.length > 0 ? input.appImage : input.execPath;
        const exec = [`"${exe.replace(/(["`$\\])/g, '\\$1')}"`, ...args].join(' ');
        const content = ['[Desktop Entry]', 'Type=Application', 'Name=Genie', 'Comment=Genie', `Exec=${exec}`, 'Hidden=false', 'NoDisplay=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
        return { kind: 'desktop-file', file, content };
    }
    return { kind: 'none', reason: `starting at sign-in is not supported on ${input.platform}` };
}

/**
 * Where Genie 1's sign-in entry would be, to read whether it is there. Genie 1 kept "launch when I
 * sign in" in the OS, not in its database, so the carry-over reads the OS: a person who had it on
 * keeps it on instead of Genie 2's first boot deleting the entry because its setting reads off.
 * Windows compares the path AND the arguments, so the query names Genie 1's `--autostart`.
 */
export type V1LoginItemQuery =
    | { readonly kind: 'none' }
    | { readonly kind: 'login-item'; readonly options: { readonly path?: string; readonly args?: readonly string[] } }
    | { readonly kind: 'desktop-file'; readonly file: string };

export function v1LoginItemQuery(input: { readonly platform: NodeJS.Platform; readonly packaged: boolean; readonly execPath: string; readonly configHome: string }): V1LoginItemQuery {
    if (!input.packaged) return { kind: 'none' };
    if (input.platform === 'win32') return { kind: 'login-item', options: { path: input.execPath, args: [V1_AUTOSTART_ARG] } };
    if (input.platform === 'darwin') return { kind: 'login-item', options: {} };
    if (input.platform === 'linux') return { kind: 'desktop-file', file: linuxAutostartFile(input.configHome) };
    return { kind: 'none' };
}
