// A DEFAULT import, deliberately: electron-updater is CommonJS and Node's ESM loader cannot see
// its getter-defined names — `import { autoUpdater }` threw on load in the built app (the
// window smoke caught it; `test/cjs-named-imports.test.ts` now guards the whole main process).
import electronUpdater from 'electron-updater';
import type { UpdaterPort } from './updater.js';
import { releaseNotesText } from '../core/whats-new.js';

const { autoUpdater } = electronUpdater;

/**
 * The ONE real `UpdaterPort` — `electron-updater`, as thin as it can be made.
 *
 * Nothing here is unit-tested, on purpose: the rules live in `UpdateHost` and are proved
 * against a fake port; this file is the seam to the library, and the only honest test of a
 * seam is the real thing on the other side of it. That test is `scripts/vm-windows-update.ps1`
 * — an installed 0.0.0 fed a 0.0.1 from a local generic feed in the Windows test VM, which
 * exercises every call below end to end without publishing anything.
 *
 * The library's feed comes from `resources/app-update.yml`, which electron-builder writes from
 * the `publish` block (GitHub, prereleases). The VM test overwrites that file with a `generic`
 * provider; nothing in this code knows or cares which.
 */
export function realElectronUpdaterPort(): UpdaterPort {
    // The library logs to nothing by default; a check that fails silently is the §0.8 shape.
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
            // An update is applied when the user says so (`install`), never on a quit they
            // meant as a quit. §7.5: Cancel always abandons rather than installing anyway.
            autoUpdater.autoInstallOnAppQuit = false;
        },

        async check() {
            const result = await autoUpdater.checkForUpdates();
            // `isUpdateAvailable` is the library's own verdict (version comparison included);
            // `result` is null when the updater is disabled (dev run without a feed).
            if (!result || !result.isUpdateAvailable) return null;
            return { version: result.updateInfo.version, notes: releaseNotesText(result.updateInfo.releaseNotes, result.updateInfo.version) };
        },

        async download(onProgress) {
            const onProgressEvent = (p: { percent: number }) => { onProgress(p.percent); };
            autoUpdater.on('download-progress', onProgressEvent);
            try {
                await autoUpdater.downloadUpdate();
            } finally {
                autoUpdater.off('download-progress', onProgressEvent);
            }
        },

        quitAndInstall() {
            // Silent (`/S`) and relaunch after: the user already said "install" in the Deck,
            // and an installer wizard appearing at that point is a second question. §7.2's
            // teardown has run by now, so there is nothing left holding the install dir open.
            autoUpdater.quitAndInstall(true, true);
        },
    };
}
