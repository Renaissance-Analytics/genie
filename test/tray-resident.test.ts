import { describe, expect, it } from 'vitest';
import {
    HIDDEN_ARG,
    TRAY_NOTICE,
    V1_AUTOSTART_ARG,
    closeAction,
    linuxAutostartFile,
    loginItemPlan,
    showOnBoot,
    trayNoticeDue,
    v1LoginItemQuery,
    type LoginItemInput,
} from '../src/core/tray-resident.js';

/**
 * TRAY-RESIDENT GENIE — the pure half. Genie 1 hid to the tray when its window closed and kept the
 * person's agents and terminals running; Genie 2 quit on `window-all-closed`. Closing the window now
 * hides it on Windows and Linux; a quit is only ever asked for, and once one is under way the close
 * is real (Electron aborts a quit whose windows refuse to close). macOS keeps its convention.
 */

describe('closeAction — what the main window’s close does', () => {
    it('HIDES on Windows and Linux when no quit is under way — counted over every non-mac desktop platform', () => {
        const platforms: NodeJS.Platform[] = ['win32', 'linux', 'freebsd'];
        const hides = platforms.filter((p) => closeAction(p, false) === 'hide');
        expect(hides).toEqual(platforms);
    });

    it('CONTROL: once a quit is under way the close is real on every platform — hiding would abort the tray’s Quit', () => {
        for (const p of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) expect(closeAction(p, true)).toBe('close');
    });

    it('macOS keeps its own convention: the window closes, the app stays (window-all-closed never quit there)', () => {
        expect(closeAction('darwin', false)).toBe('close');
    });
});

describe('showOnBoot — start minimised', () => {
    it('shows the window on an ordinary launch', () => {
        expect(showOnBoot({ startMinimized: false, argv: ['Genie.exe'] })).toBe(true);
    });

    it('start minimised boots WITHOUT the window, whatever the arguments', () => {
        expect(showOnBoot({ startMinimized: true, argv: ['Genie.exe'] })).toBe(false);
        expect(showOnBoot({ startMinimized: true, argv: ['Genie.exe', HIDDEN_ARG] })).toBe(false);
    });

    it('a sign-in launch that carries --hidden — or Genie 1’s --autostart, still registered until Genie 2 rewrites it — stays in the tray', () => {
        expect(showOnBoot({ startMinimized: false, argv: ['Genie.exe', '--hidden'] })).toBe(false);
        expect(showOnBoot({ startMinimized: false, argv: ['Genie.exe', V1_AUTOSTART_ARG] })).toBe(false);
        // CONTROL: an unrelated flag does not hide anything.
        expect(showOnBoot({ startMinimized: false, argv: ['Genie.exe', '--doctor-something'] })).toBe(true);
    });
});

describe('the one-time tray notice', () => {
    it('is due on a close that hid the window and was never shown; never on a real close; never twice', () => {
        expect(trayNoticeDue('hide', false)).toBe(true);
        expect(trayNoticeDue('hide', true)).toBe(false);
        expect(trayNoticeDue('close', false)).toBe(false);
        expect(TRAY_NOTICE.title).toBe('Genie is still running in the tray');
    });
});

describe('loginItemPlan — launch at sign-in', () => {
    const base: LoginItemInput = { platform: 'win32', packaged: true, launchAtLogin: true, startMinimized: false, execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\Genie\\Genie.exe', appImage: null, configHome: '/home/a/.config' };

    it('Windows: openAtLogin with the installed exe, and --hidden only when start minimised is on', () => {
        expect(loginItemPlan(base)).toEqual({ kind: 'login-item', settings: { openAtLogin: true, path: base.execPath, args: [] } });
        expect(loginItemPlan({ ...base, startMinimized: true })).toEqual({ kind: 'login-item', settings: { openAtLogin: true, path: base.execPath, args: ['--hidden'] } });
        expect(loginItemPlan({ ...base, launchAtLogin: false })).toEqual({ kind: 'login-item', settings: { openAtLogin: false, path: base.execPath, args: [] } });
    });

    it('macOS: openAtLogin only — a login item there takes no arguments', () => {
        expect(loginItemPlan({ ...base, platform: 'darwin', startMinimized: true })).toEqual({ kind: 'login-item', settings: { openAtLogin: true } });
    });

    it('Linux: a freedesktop autostart entry (Electron has no login-item API there), the AppImage path when there is one; off removes it', () => {
        const on = loginItemPlan({ ...base, platform: 'linux', execPath: '/tmp/.mount_GenieX/genie', appImage: '/home/a/Apps/Genie.AppImage', startMinimized: true });
        expect(on.kind).toBe('desktop-file');
        if (on.kind !== 'desktop-file') return;
        expect(on.file).toBe('/home/a/.config/autostart/genie.desktop');
        expect(on.content).toContain('Exec="/home/a/Apps/Genie.AppImage" --hidden\n');
        expect(on.content).not.toContain('.mount_');
        expect(loginItemPlan({ ...base, platform: 'linux', launchAtLogin: false })).toEqual({ kind: 'desktop-file', file: '/home/a/.config/autostart/genie.desktop', content: null });
    });

    it('a development run is never registered — the entry would outlive the build it points at', () => {
        expect(loginItemPlan({ ...base, packaged: false }).kind).toBe('none');
    });
});

describe('v1LoginItemQuery — Genie 1 kept "launch at sign-in" in the OS, so the carry-over reads the OS', () => {
    it('Windows asks for Genie 1’s exact entry: the same exe with --autostart', () => {
        expect(v1LoginItemQuery({ platform: 'win32', packaged: true, execPath: 'C:\\G\\Genie.exe', configHome: '' })).toEqual({ kind: 'login-item', options: { path: 'C:\\G\\Genie.exe', args: ['--autostart'] } });
    });

    it('Linux looks for Genie 1’s autostart file — the same file Genie 2 writes', () => {
        expect(v1LoginItemQuery({ platform: 'linux', packaged: true, execPath: '/x', configHome: '/home/a/.config/' })).toEqual({ kind: 'desktop-file', file: linuxAutostartFile('/home/a/.config') });
    });

    it('a development run reads nothing', () => {
        expect(v1LoginItemQuery({ platform: 'win32', packaged: false, execPath: 'x', configHome: '' })).toEqual({ kind: 'none' });
    });
});
