import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * ELECTRON'S BINARY, INSTALLED ONCE, BEFORE ANY TEST FILE RUNS (genie#1260).
 *
 * Electron 45 has no postinstall: `npm ci` leaves `node_modules/electron/dist` empty, and the binary arrives on the first
 * `require('electron')` — electron's index.js downloads it and unzips it into place. In the suite that first require was
 * a test file importing src/main/tray.ts, in one worker, while test/plugin-sandbox.test.ts in another spawned that very
 * binary as Node. Mid-unzip the file is open for writing, and Linux refuses to execute it: `spawn ETXTBSY`
 * (omarchy-test, PR #1258; forced on purpose by a probe that spawned the binary during electron's own install). Earlier
 * in the unzip the binary was simply absent, and the Electron cases dropped out of the run without a word.
 *
 * Here, in vitest's globalSetup, the same require runs before any worker starts. Its install is synchronous (a child
 * `node install.js` that has exited when the require returns), so every write handle is closed before a test can spawn
 * the binary. A download that fails fails the run here, once, instead of inside whichever file got there first.
 */
export default function setup(): void {
    const electron = createRequire(import.meta.url)('electron') as unknown;
    if (typeof electron !== 'string' || !existsSync(electron)) {
        throw new Error(`Electron's binary is not installed (node_modules/electron resolved to ${String(electron)})`);
    }
}
