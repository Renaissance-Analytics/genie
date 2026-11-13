import type { AppUpdater } from 'electron-updater';
import type { AllPublishOptions } from 'builder-util-runtime';
import yaml from 'js-yaml';
import type { UpdaterPort } from './updater.js';
import { configurePublishedFeed } from './published-feed.js';

export type ElectronUpdaterClient = Pick<AppUpdater, 'logger' | 'allowPrerelease' | 'autoDownload' | 'autoInstallOnAppQuit' | 'isUpdaterActive' | 'setFeedURL' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on' | 'off'>;
export interface UpdateConfigurationSource {
    readonly path: string;
    readText(path: string): Promise<string>;
}

/** Read the library's app configuration, preserving stock providers except our public GitHub adapter. */
export function createElectronUpdaterPort(autoUpdater: ElectronUpdaterClient, configuration: UpdateConfigurationSource): UpdaterPort {
    // The library logs to nothing by default; a check that fails silently is the §0.8 shape.
    autoUpdater.logger = {
        info: (m: unknown) => console.log(`[updater] ${String(m)}`),
        warn: (m: unknown) => console.warn(`[updater] ${String(m)}`),
        error: (m: unknown) => console.error(`[updater] ${String(m)}`),
        debug: () => {},
    };
    let initialization: Promise<void> | null = null;
    function initializeFeed(): Promise<void> {
        if (!initialization) {
            initialization = (async () => {
                const text = await configuration.readText(configuration.path);
                let config: unknown;
                // Do not expose YAML source fragments (which may include credentials) in a parser error.
                try { config = yaml.load(text); }
                catch { throw new Error('The update feed configuration could not be read as YAML.'); }
                if (!config || typeof config !== 'object' || Array.isArray(config) || !('provider' in config) || typeof config.provider !== 'string' || !config.provider) {
                    throw new Error('The update feed configuration has no valid provider.');
                }
                configurePublishedFeed(autoUpdater, config as AllPublishOptions);
            })().catch((error: unknown) => {
                // Only failures are retried. Successful initialization must not replace a selected download provider.
                initialization = null;
                throw error;
            });
        }
        return initialization;
    }
    return {
        configure(channel) {
            autoUpdater.allowPrerelease = channel.allowPrerelease;
            autoUpdater.autoDownload = channel.autoDownload;
            // An update is applied when the user says so (`install`), never on a quit they
            // meant as a quit. §7.5: Cancel always abandons rather than installing anyway.
            autoUpdater.autoInstallOnAppQuit = false;
        },
        async check() {
            // Disabled dev runs have no packaged feed. Let the library retain its normal disabled verdict.
            if (autoUpdater.isUpdaterActive()) await initializeFeed();
            const result = await autoUpdater.checkForUpdates();
            // `isUpdateAvailable` is the library's own verdict (version comparison included);
            // `result` is null when the updater is disabled (dev run without a feed).
            if (!result || !result.isUpdateAvailable) return null;
            // The version only: its notes come from GitHub's releases API (core/update-notes.ts), not the feed's HTML.
            return { version: result.updateInfo.version };
        },
        async download(onProgress) {
            const onProgressEvent = (p: { percent: number }) => { onProgress(p.percent); };
            autoUpdater.on('download-progress', onProgressEvent);
            try { await autoUpdater.downloadUpdate(); }
            finally { autoUpdater.off('download-progress', onProgressEvent); }
        },
        quitAndInstall() {
            // Silent (`/S`) and relaunch after: the user already said "install" in the Deck,
            // and an installer wizard appearing at that point is a second question. §7.2's
            // teardown has run by now, so there is nothing left holding the install dir open.
            autoUpdater.quitAndInstall(true, true);
        },
    };
}
