import { PUBLISHER_KEYS } from '../src/core/plugin-keys.js';
import { checkPackageCommand } from '../src/main/check-package.js';
import { genieCatalog } from '../src/main/genie-catalog.js';

/** `npm run check:package -- <folder>` (GApps v2, V6, Tynn #571): src/main/check-package.ts, with Genie's own keys and catalog. */
process.exitCode = await checkPackageCommand(process.argv.slice(2), {
    keys: PUBLISHER_KEYS,
    catalog: () => genieCatalog(),
    write: (line) => { console.log(line); },
});
