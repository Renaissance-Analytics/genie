import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

/**
 * "Launch Genie when I sign in" — a single boolean exposed to Settings.
 *
 *   - macOS / Windows: routed through Electron's `setLoginItemSettings`,
 *     which writes to the OS's login-items / Run-registry-key. Genie
 *     starts hidden (tray-only) when launched by the OS so the user
 *     isn't ambushed with a window on every reboot.
 *
 *   - Linux: there's no Electron API for autostart on this platform,
 *     so we write a freedesktop.org `.desktop` file to
 *     `~/.config/autostart/`. Most desktop environments (GNOME, KDE,
 *     XFCE, Cinnamon) honour it.
 *
 *   - Dev / non-packaged: we no-op on `set` because the autostart
 *     entry would point at `electron.exe + a script path` which is
 *     meaningless after the dev session ends. Settings UI shows the
 *     toggle but flags it as dev-only.
 */

const LINUX_AUTOSTART_FILENAME = 'genie.desktop';

export function isAutostartSupported(): boolean {
    // We can read state in dev mode (just to render the toggle), but
    // writing only makes sense for packaged installs.
    return app.isPackaged;
}

export function getAutostart(): boolean {
    if (process.platform === 'linux') {
        return fs.existsSync(linuxDesktopPath());
    }
    try {
        return app.getLoginItemSettings().openAtLogin;
    } catch {
        return false;
    }
}

export function setAutostart(enabled: boolean): void {
    if (!app.isPackaged) {
        // Dev session — silently no-op. We don't want a stale autostart
        // entry pointing at a one-time dev path after the session ends.
        return;
    }

    if (process.platform === 'linux') {
        const file = linuxDesktopPath();
        const dir = path.dirname(file);
        if (enabled) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, buildLinuxDesktopEntry(), 'utf8');
        } else {
            try { fs.unlinkSync(file); } catch { /* already gone */ }
        }
        return;
    }

    // macOS + Windows
    app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true,
        // macOS handles the path automatically. On Windows we pass an
        // explicit `--autostart` arg so background.ts can detect it and
        // keep the master window closed (tray-only first run on boot).
        ...(process.platform === 'win32'
            ? { path: process.execPath, args: ['--autostart'] }
            : {}),
    });
}

/** True when this Genie process was launched by the OS at sign-in. */
export function launchedFromAutostart(): boolean {
    if (process.argv.includes('--autostart')) return true;
    if (process.platform === 'darwin') {
        try {
            return app.getLoginItemSettings().wasOpenedAtLogin;
        } catch {
            return false;
        }
    }
    return false;
}

function linuxDesktopPath(): string {
    const home = os.homedir();
    return path.join(home, '.config', 'autostart', LINUX_AUTOSTART_FILENAME);
}

function buildLinuxDesktopEntry(): string {
    const exe = process.execPath;
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Genie',
        'Comment=Tynn desktop companion',
        `Exec=${exe} --autostart`,
        'Hidden=false',
        'NoDisplay=false',
        'X-GNOME-Autostart-enabled=true',
        'X-GNOME-Autostart-Delay=5',
        '',
    ].join('\n');
}
