import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../src/main/settings-store.js';
import { applyLoginItem, wireCloseToTray, wireLoginItem, type ClosableWindow, type LoginItemEnv, type LoginItemPort, type ResidenceSettings } from '../src/main/tray-residence.js';

/**
 * TRAY-RESIDENT GENIE — the main-process wiring, driven with a fake window and a fake OS and the
 * REAL settings store. Closing the main window hides it (counted), says so once ever (the marker
 * survives a restart), and stops hiding the moment a quit is under way. "Launch at sign-in" reaches
 * the OS on change, at boot, and follows start minimised; Genie 1's entry is adopted, not deleted.
 */

/** A window that records what its close did, the way Electron runs the listeners. */
function fakeWindow() {
    const listeners: Array<(e: { preventDefault(): void }) => void> = [];
    const counts = { hide: 0, prevented: 0, closed: 0 };
    const win: ClosableWindow = {
        on: (_event, listener) => { listeners.push(listener); },
        hide: () => { counts.hide += 1; },
    };
    const close = () => {
        let prevented = false;
        for (const l of listeners) l({ preventDefault: () => { prevented = true; } });
        if (prevented) counts.prevented += 1; else counts.closed += 1;
    };
    return { win, close, counts };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-tray-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('wireCloseToTray', () => {
    it('Windows: three closes → three hides, zero real closes, and the notice exactly ONCE', async () => {
        const store = await SettingsStore.open(dir);
        const { win, close, counts } = fakeWindow();
        const notify = vi.fn();
        wireCloseToTray(win, { platform: 'win32', quitting: () => false, settings: store, notify });
        close(); close(); close();
        expect(counts).toEqual({ hide: 3, prevented: 3, closed: 0 });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]![0]).toMatchObject({ title: 'Genie is still running in the tray' });
        // The marker reaches the file (and the write settles before the directory is removed).
        await vi.waitFor(async () => expect((await SettingsStore.open(dir)).get('tray_notice_shown')).toBe(true));
    });

    it('the notice stays shown across a restart: the marker is a setting, so the next Genie says nothing', async () => {
        const first = await SettingsStore.open(dir);
        const a = fakeWindow();
        const notifyA = vi.fn();
        wireCloseToTray(a.win, { platform: 'linux', quitting: () => false, settings: first, notify: notifyA });
        a.close();
        expect(notifyA).toHaveBeenCalledTimes(1);
        await vi.waitFor(async () => expect((await SettingsStore.open(dir)).get('tray_notice_shown')).toBe(true));
        const reopened = await SettingsStore.open(dir);
        const b = fakeWindow();
        const notifyB = vi.fn();
        wireCloseToTray(b.win, { platform: 'linux', quitting: () => false, settings: reopened, notify: notifyB });
        b.close();
        expect(b.counts.hide).toBe(1);
        expect(notifyB).not.toHaveBeenCalled();
    });

    it('CONTROL: once a quit is under way the close is REAL — not prevented, not hidden, no notice', async () => {
        const store = await SettingsStore.open(dir);
        const { win, close, counts } = fakeWindow();
        const notify = vi.fn();
        let quitting = false;
        wireCloseToTray(win, { platform: 'win32', quitting: () => quitting, settings: store, notify });
        close();
        quitting = true;
        close();
        expect(counts).toEqual({ hide: 1, prevented: 1, closed: 1 });
        expect(notify).toHaveBeenCalledTimes(1);
        await vi.waitFor(async () => expect((await SettingsStore.open(dir)).get('tray_notice_shown')).toBe(true));
    });

    it('macOS: the close is the platform’s own — nothing prevented, nothing hidden, no notice', async () => {
        const store = await SettingsStore.open(dir);
        const { win, close, counts } = fakeWindow();
        const notify = vi.fn();
        wireCloseToTray(win, { platform: 'darwin', quitting: () => false, settings: store, notify });
        close();
        expect(counts).toEqual({ hide: 0, prevented: 0, closed: 1 });
        expect(notify).not.toHaveBeenCalled();
    });
});

/** A fake OS: records every call, holds what a Genie 1 install would have left. */
function fakePort(v1: { loginItem?: boolean; files?: string[] } = {}) {
    const set: unknown[] = [];
    const files = new Map<string, string>((v1.files ?? []).map((f) => [f, '[Desktop Entry]\n']));
    const port: LoginItemPort = {
        setLoginItemSettings: (s) => { set.push(s); },
        getLoginItemSettings: (o) => ({ openAtLogin: v1.loginItem === true && o.args?.includes('--autostart') === true }),
        exists: (f) => files.has(f),
        writeFile: (f, c) => { files.set(f, c); },
        removeFile: (f) => { files.delete(f); },
    };
    return { port, set, files };
}

const WIN: LoginItemEnv = { platform: 'win32', packaged: true, execPath: 'C:\\P\\Genie\\Genie.exe', appImage: null, configHome: '/unused' };

describe('wireLoginItem', () => {
    it('applies at boot, then on every change of launch_at_login — with the right arguments', async () => {
        const store = await SettingsStore.open(dir);
        const { port, set } = fakePort();
        await wireLoginItem(store, port, WIN);
        expect(set).toEqual([{ openAtLogin: false, path: WIN.execPath, args: [] }]);
        await store.set('launch_at_login', true);
        expect(set.at(-1)).toEqual({ openAtLogin: true, path: WIN.execPath, args: [] });
        await store.set('start_minimized', true);
        expect(set.at(-1)).toEqual({ openAtLogin: true, path: WIN.execPath, args: ['--hidden'] });
        await store.set('launch_at_login', false);
        expect(set.at(-1)).toEqual({ openAtLogin: false, path: WIN.execPath, args: ['--hidden'] });
        expect(set).toHaveLength(4);
    });

    it('CONTROL: an unrelated setting changes nothing at the OS', async () => {
        const store = await SettingsStore.open(dir);
        const { port, set } = fakePort();
        await wireLoginItem(store, port, WIN);
        await store.set('theme', 'dark');
        expect(set).toHaveLength(1);
    });

    it('Genie 1’s sign-in entry is ADOPTED — the setting reads on and the entry is rewritten, never deleted', async () => {
        const store = await SettingsStore.open(dir);
        const { port, set } = fakePort({ loginItem: true });
        await wireLoginItem(store, port, WIN);
        expect(store.get('launch_at_login')).toBe(true);
        expect(set.every((s) => (s as { openAtLogin: boolean }).openAtLogin === true)).toBe(true);
        expect(set.at(-1)).toEqual({ openAtLogin: true, path: WIN.execPath, args: [] });
    });

    it('Linux writes and removes the autostart file', async () => {
        const store = await SettingsStore.open(dir);
        const { port, files } = fakePort();
        await wireLoginItem(store, port, { platform: 'linux', packaged: true, execPath: '/opt/Genie/genie', appImage: null, configHome: '/home/a/.config' });
        expect(files.size).toBe(0);
        await store.set('launch_at_login', true);
        expect(files.get('/home/a/.config/autostart/genie.desktop')).toContain('Exec="/opt/Genie/genie"');
        await store.set('launch_at_login', false);
        expect(files.size).toBe(0);
    });

    it('a development run never touches the OS', async () => {
        const store = await SettingsStore.open(dir);
        const { port, set } = fakePort({ loginItem: true });
        await wireLoginItem(store, port, { ...WIN, packaged: false });
        await store.set('launch_at_login', true);
        expect(set).toEqual([]);
    });

    it('applyLoginItem: a failure in the OS call is the caller’s to report — wireLoginItem keeps the boot going', async () => {
        const store: ResidenceSettings = await SettingsStore.open(dir);
        const port: LoginItemPort = { ...fakePort().port, setLoginItemSettings: () => { throw new Error('registry denied'); } };
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(wireLoginItem(store, port, WIN)).resolves.toBeUndefined();
        expect(() => applyLoginItem(port, { kind: 'login-item', settings: { openAtLogin: true } })).toThrow('registry denied');
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});
