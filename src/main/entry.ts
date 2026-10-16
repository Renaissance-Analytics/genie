import { app } from 'electron';
import { entryFor } from '../core/entry-mode.js';
import { appUserModelIdFor } from './app-identity.js';

/**
 * THE APP'S ENTRY (package.json `main`). It decides which Genie this launch is BEFORE anything else loads: ESM runs every
 * static import before the first statement, so a `--doctor` check at the top of main.ts would already have loaded the
 * store, the registry and the rest. Each side is imported lazily, so doctor mode never loads Genie's config or database
 * modules and Genie never loads doctor mode.
 */
// Before any window exists, on either side: the installed shortcut's AppUserModelID (main/app-identity.ts), so the
// taskbar groups Genie's windows with the app the person installed and shows its icon.
const appUserModelId = appUserModelIdFor(process.platform, app.isPackaged);
if (appUserModelId !== null) app.setAppUserModelId(appUserModelId);

if (entryFor(process.argv) === 'doctor') {
    void import('./doctor.js').then((m) => m.runDoctor());
} else {
    void import('./main.js');
}
