import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WHO GENIE IS TO THE OS — its AppUserModelID and its window icon (the owner, 2026-10-15: "the app icon is missing" —
 * a blank white page on the Windows taskbar, nothing in the title bar's upper-left).
 *
 * ## The AppUserModelID
 *
 * The installer's Start-menu shortcut carries `ai.tynn.genie` (electron-builder.yml `appId`; app-builder-lib's NSIS
 * template stamps it on the .lnk with `WinShell::SetLnkAUMI`). The running process never said so: Electron, left alone,
 * names itself `electron.app.<name>`. Windows groups a taskbar button, and picks its icon, by that ID — so the running
 * window was a different application from the one the person installed and pinned, and the taskbar had no shortcut to
 * take its icon from. `app.setAppUserModelId(appId)` is the documented pairing (Electron's Windows notes; the shortcut
 * and the process must agree). test/app-icon.test.ts holds this constant equal to the builder's appId.
 *
 * Packaged only: a dev run is `electron.exe` from a worktree, and claiming the installed Genie's ID there would fold a
 * dev window into the installed app's taskbar button (and its pinned shortcut would launch the installed one).
 */
export const APP_USER_MODEL_ID = 'ai.tynn.genie';

export function appUserModelIdFor(platform: NodeJS.Platform, packaged: boolean): string | null {
    return platform === 'win32' && packaged ? APP_USER_MODEL_ID : null;
}

/**
 * THE WINDOW ICON, on every platform and in the installed app as well as a dev run. The main window used to take
 * `build/icon.png` only when it existed beside `dist/` — which is never, in an installed app (electron-builder.yml packs
 * `dist/**` and package.json, nothing from build/) — so the installed window carried no icon of its own. The icons now
 * ship as extra resources (`<resources>/icon.ico`, `<resources>/icon.png`); a dev run reads the repo's build/.
 * Windows takes the multi-size .ico (16 px in the title/taskbar, 256 px in Alt+Tab, each drawn for its size); elsewhere
 * the 1024 px PNG. `null` when neither is on disk: no icon option rather than a path to nothing.
 */
export function windowIconPath(platform: NodeJS.Platform, resourcesPath: string | undefined, buildDir: string, exists: (p: string) => boolean): string | null {
    const file = platform === 'win32' ? 'icon.ico' : 'icon.png';
    const candidates = [...(resourcesPath ? [join(resourcesPath, file)] : []), join(buildDir, file)];
    for (const p of candidates) if (exists(p)) return p;
    return null;
}

/**
 * The `icon` option for a Genie `BrowserWindow` created from `here` (the built `dist/main`): every Genie window that
 * reaches the taskbar spreads this — the main window, Take Over and file windows, the question window, doctor mode.
 */
export function genieWindowIcon(here: string): { icon: string } | Record<string, never> {
    const icon = windowIconPath(process.platform, process.resourcesPath, join(here, '..', '..', 'build'), existsSync);
    return icon === null ? {} : { icon };
}
