// Prepare native modules for the E2E suite, which runs inside ELECTRON (not
// node). Only better-sqlite3 needs attention: the `test` (vitest) pretest runs
// `npm rebuild better-sqlite3`, which leaves it at the NODE ABI — so the next
// E2E run's Electron can't dlopen it (NODE_MODULE_VERSION mismatch) and the app
// dies on boot before opening a window (a Playwright `firstWindow` timeout).
//
// We fetch better-sqlite3's ELECTRON prebuild directly via prebuild-install —
// no compilation. We deliberately do NOT use `electron-builder install-app-deps`
// or `electron-rebuild`: both also try to node-gyp-compile node-pty, which fails
// on machines without VS Build Tools. node-pty is left untouched (it already
// matches the Electron ABI from install), so only better-sqlite3 is refreshed.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronVersion = require(
    path.join(root, 'node_modules', 'electron', 'package.json'),
).version;

// Run prebuild-install's JS entry via `node` rather than the `.bin` shim:
// Node's execFileSync can't spawn a Windows `.cmd` directly (EINVAL), and
// invoking the JS entry is shell-free and cross-platform.
const pbiPkgPath = path.join(root, 'node_modules', 'prebuild-install', 'package.json');
const pbiPkg = require(pbiPkgPath);
const binEntry =
    typeof pbiPkg.bin === 'string' ? pbiPkg.bin : pbiPkg.bin['prebuild-install'];
const prebuildJs = path.join(path.dirname(pbiPkgPath), binEntry);

console.log(
    `[e2e] fetching better-sqlite3 prebuild for electron ${electronVersion} (${process.arch})`,
);
execFileSync(
    process.execPath,
    [prebuildJs, '-r', 'electron', '-t', electronVersion, '--arch', process.arch],
    {
        cwd: path.join(root, 'node_modules', 'better-sqlite3'),
        stdio: 'inherit',
    },
);
