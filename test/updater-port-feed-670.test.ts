import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createElectronUpdaterPort, type ElectronUpdaterClient } from '../src/main/electron-updater-adapter.js';
import { PublishedGitHubProvider } from '../src/main/published-github-provider.js';

const PUBLIC = 'provider: github\nowner: synthetic-owner\nrepo: synthetic-app\n';
const GENERIC = 'provider: generic\nurl: http://127.0.0.1:12345/synthetic/\n';
const VERSION = '2.0.0-beta.62';
function rig(text = PUBLIC) {
    const events: string[] = []; const emitter = new EventEmitter();
    const state = { active: true, available: true, failDownload: false };
    const setFeedURL = vi.fn(() => { events.push('feed'); });
    const checkForUpdates = vi.fn(async () => { events.push('check'); return state.active ? { isUpdateAvailable: state.available, updateInfo: { version: VERSION } } : null; });
    const downloadUpdate = vi.fn(async () => { emitter.emit('download-progress', { percent: 35 }); if (state.failDownload) throw new Error('Synthetic download interrupted.'); return []; });
    const quitAndInstall = vi.fn();
    const library = {
        logger: null, allowPrerelease: false, autoDownload: true, autoInstallOnAppQuit: true,
        isUpdaterActive: () => state.active, setFeedURL, checkForUpdates, downloadUpdate, quitAndInstall,
        on: (event: string, callback: (...args: unknown[]) => void) => emitter.on(event, callback),
        off: (event: string, callback: (...args: unknown[]) => void) => emitter.off(event, callback),
    };
    const source = { path: '/synthetic/resources/app-update.yml', readText: vi.fn(async (_path: string) => { events.push('read'); return text; }) };
    const port = createElectronUpdaterPort(library as unknown as ElectronUpdaterClient, source);
    return { port, source, library, events, state, emitter };
}

describe('the real updater adapter loads the actual feed before checking (#670)', () => {
    it('reads packaged YAML and installs the configured public provider before asking the library to check', async () => {
        const w = rig();
        await expect(w.port.check()).resolves.toEqual({ version: VERSION });
        expect(w.source.readText).toHaveBeenCalledExactlyOnceWith(w.source.path);
        expect(w.library.setFeedURL).toHaveBeenCalledExactlyOnceWith({ provider: 'custom', owner: 'synthetic-owner', repo: 'synthetic-app', updateProvider: PublishedGitHubProvider });
        expect(w.events).toEqual(['read', 'feed', 'check']);
    });

    it('concurrent checks share one configuration load and a later check keeps the selected provider', async () => {
        const w = rig(); await Promise.all([w.port.check(), w.port.check()]); await w.port.check();
        expect(w.source.readText).toHaveBeenCalledTimes(1);
        expect(w.library.setFeedURL).toHaveBeenCalledTimes(1);
        expect(w.events.slice(0, 2)).toEqual(['read', 'feed']);
        expect(w.library.checkForUpdates).toHaveBeenCalledTimes(3);
    });

    it('malformed packaged YAML is a plain failure and never proceeds to an unconfigured check', async () => {
        const w = rig('provider: [\n');
        await expect(w.port.check()).rejects.toThrow(/update feed configuration/i);
        expect(w.library.checkForUpdates).not.toHaveBeenCalled();
        expect(w.library.setFeedURL).not.toHaveBeenCalled();
    });

    it('a failed config read is reported; an explicit later check retries initialization', async () => {
        const w = rig(); const failed = new Error('Synthetic update config unavailable.');
        w.source.readText.mockRejectedValueOnce(failed);
        await expect(w.port.check()).rejects.toBe(failed);
        expect(w.library.checkForUpdates).not.toHaveBeenCalled();
        await expect(w.port.check()).resolves.toEqual({ version: VERSION });
        expect(w.source.readText).toHaveBeenCalledTimes(2);
        expect(w.library.setFeedURL).toHaveBeenCalledTimes(1);
        expect(w.library.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: the generic feed written by the VM remains the library feed', async () => {
        const w = rig(GENERIC); await expect(w.port.check()).resolves.toEqual({ version: VERSION });
        expect(w.library.setFeedURL).not.toHaveBeenCalled();
        expect(w.library.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: a disabled development updater needs no packaged configuration', async () => {
        const w = rig(); w.state.active = false;
        await expect(w.port.check()).resolves.toBeNull();
        expect(w.source.readText).not.toHaveBeenCalled();
        expect(w.library.setFeedURL).not.toHaveBeenCalled();
    });

    it('CONTROL: no available update stays null and never downloads or installs', async () => {
        const w = rig(); w.state.available = false;
        await expect(w.port.check()).resolves.toBeNull();
        expect(w.library.downloadUpdate).not.toHaveBeenCalled();
        expect(w.library.quitAndInstall).not.toHaveBeenCalled();
    });

    it('CONTROL: channel, explicit download progress/cleanup and explicit install still reach the library', async () => {
        const w = rig(); w.port.configure({ allowPrerelease: true, autoDownload: false });
        expect(w.library).toMatchObject({ allowPrerelease: true, autoDownload: false, autoInstallOnAppQuit: false });
        const progress = vi.fn(); await w.port.download(progress); expect(progress).toHaveBeenCalledExactlyOnceWith(35);
        expect(w.emitter.listenerCount('download-progress')).toBe(0);
        w.state.failDownload = true; await expect(w.port.download(progress)).rejects.toThrow('Synthetic download interrupted.');
        expect(w.emitter.listenerCount('download-progress')).toBe(0);
        w.port.quitAndInstall(); expect(w.library.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
        expect(w.source.readText).not.toHaveBeenCalled();
    });

    it('CONTROL: the production entry delegates through the supported app configuration path and file reader', () => {
        const entry = readFileSync('src/main/electron-updater-port.ts', 'utf8');
        expect(entry).toContain('new ElectronAppAdapter()');
        expect(entry).toContain("createElectronUpdaterPort(autoUpdater, { path: app.appUpdateConfigPath, readText: (path) => readFile(path, 'utf8') })");
        expect(entry).not.toMatch(/configOnDisk|clientPromise|loadUpdateConfig|getFeedURL/);
    });
});
