// A DEFAULT import, deliberately: electron-updater is CommonJS and Node's ESM loader cannot see
// its getter-defined names — `import { autoUpdater }` threw on load in the built app (the
// window smoke caught it; `test/cjs-named-imports.test.ts` now guards the whole main process).
import electronUpdater from 'electron-updater';
import electronAppAdapter from 'electron-updater/out/ElectronAppAdapter.js';
import { readFile } from 'node:fs/promises';
import type { UpdaterPort } from './updater.js';
import { createElectronUpdaterPort } from './electron-updater-adapter.js';

const { autoUpdater } = electronUpdater;
const { ElectronAppAdapter } = electronAppAdapter;

/**
 * The ONE real `UpdaterPort` — `electron-updater`, as thin as it can be made.
 *
 * The library adapter's call ordering is tested through injected library/file boundaries.
 * The real installed-app seam is `scripts/vm-windows-update.ps1`
 * — an installed 0.0.0 fed a 0.0.1 from a local generic feed in the Windows test VM, which
 * exercises every call below end to end without publishing anything.
 *
 * The library's feed comes from `resources/app-update.yml`, which electron-builder writes from
 * the `publish` block (GitHub, prereleases). The VM test overwrites that file with a `generic`
 * provider; its actual file path and contents must be preserved.
 */
export function realElectronUpdaterPort(): UpdaterPort {
    const app = new ElectronAppAdapter();
    return createElectronUpdaterPort(autoUpdater, { path: app.appUpdateConfigPath, readText: (path) => readFile(path, 'utf8') });
}
