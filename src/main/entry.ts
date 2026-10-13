import { entryFor } from '../core/entry-mode.js';

/**
 * THE APP'S ENTRY (package.json `main`). It decides which Genie this launch is BEFORE anything else loads: ESM runs every
 * static import before the first statement, so a `--doctor` check at the top of main.ts would already have loaded the
 * store, the registry and the rest. Each side is imported lazily, so doctor mode never loads Genie's config or database
 * modules and Genie never loads doctor mode.
 */
if (entryFor(process.argv) === 'doctor') {
    void import('./doctor.js').then((m) => m.runDoctor());
} else {
    void import('./main.js');
}
