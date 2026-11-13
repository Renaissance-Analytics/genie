import type { AppUpdater } from 'electron-updater';
import type { UpdaterPort } from './updater.js';

export type ElectronUpdaterClient = Pick<AppUpdater, 'logger' | 'allowPrerelease' | 'autoDownload' | 'autoInstallOnAppQuit' | 'isUpdaterActive' | 'setFeedURL' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on' | 'off'>;
export interface UpdateConfigurationSource {
    readonly path: string;
    readText(path: string): Promise<string>;
}

/** The actual library adapter, with its existing behavior extracted unchanged before config-loading assertion RED. */
export function createElectronUpdaterPort(autoUpdater: ElectronUpdaterClient, _configuration: UpdateConfigurationSource): UpdaterPort {
    autoUpdater.logger = {
        info: (m: unknown) => console.log(`[updater] ${String(m)}`),
        warn: (m: unknown) => console.warn(`[updater] ${String(m)}`),
        error: (m: unknown) => console.error(`[updater] ${String(m)}`),
        debug: () => {},
    };
    return {
        configure(channel) {
            autoUpdater.allowPrerelease = channel.allowPrerelease;
            autoUpdater.autoDownload = channel.autoDownload;
            autoUpdater.autoInstallOnAppQuit = false;
        },
        async check() {
            const result = await autoUpdater.checkForUpdates();
            if (!result || !result.isUpdateAvailable) return null;
            return { version: result.updateInfo.version };
        },
        async download(onProgress) {
            const onProgressEvent = (p: { percent: number }) => { onProgress(p.percent); };
            autoUpdater.on('download-progress', onProgressEvent);
            try { await autoUpdater.downloadUpdate(); }
            finally { autoUpdater.off('download-progress', onProgressEvent); }
        },
        quitAndInstall() { autoUpdater.quitAndInstall(true, true); },
    };
}
