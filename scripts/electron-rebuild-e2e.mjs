// Prepare native modules for the E2E suite, which runs inside ELECTRON (not
// node). Only better-sqlite3 needs attention: the `test` (vitest) pretest runs
// `npm rebuild better-sqlite3`, which leaves it at the NODE ABI — so the next
// E2E run's Electron can't dlopen it (NODE_MODULE_VERSION mismatch) and the app
// dies on boot before opening a window (a Playwright `firstWindow` timeout).
//
// We fetch better-sqlite3's ELECTRON prebuild directly via prebuild-install —
// no compilation. We deliberately do NOT use `electron-builder install-app-deps`
// or `electron-rebuild`: both also try to node-gyp-compile node-pty, which fails
// on machines without VS Build Tools. node-pty is not rebuilt here (it already
// matches the Electron ABI from install) — but where something ELSE has rebuilt
// it, its ConPTY support files need putting back; see the second half.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

// ---------------------------------------------------------------------------
// node-pty's ConPTY support files, when a native rebuild has been through here.
//
// On Windows node-pty spawns through ConPTY, which needs `conpty.dll` +
// `OpenConsole.exe` sitting in a `conpty/` folder BESIDE the binding it loaded.
// Those are not compiled: node-pty's own `postinstall` copies them out of its
// `third_party/` into `build/Release/conpty/`.
//
// `electron-builder install-app-deps` (our npm postinstall) drives @electron/
// rebuild, which calls node-gyp DIRECTLY and runs no npm lifecycle scripts. So on
// a machine where that rebuild succeeds — every windows-latest runner, which ships
// the C++ toolchain — node-pty ends up with a freshly built `build/Release/pty.node`
// and NO `conpty/` beside it. node-pty's loader prefers `build/Release` over the
// shipped `prebuilds/`, so it then loads a binding that immediately throws
// `Cannot find conpty.dll`, and NOTHING in the app can open a terminal.
//
// That is invisible until something actually spawns a pty. The master-window E2E
// does (genie#228), and on the Windows leg it found exactly this: panels mounted,
// xterms mounted, and main holding no pty at all.
//
// The fix is to run node-pty's OWN post-install step, not to copy files by hand —
// it knows its arch mapping and its vendored ConPTY version. Guarded on the file
// actually being missing, so a correctly-installed tree is left alone.
const nodePty = path.join(root, 'node_modules', 'node-pty');
const ptyRelease = path.join(nodePty, 'build', 'Release');
const conptyDll = path.join(ptyRelease, 'conpty', 'conpty.dll');
if (
    process.platform === 'win32' &&
    fs.existsSync(ptyRelease) &&
    !fs.existsSync(conptyDll)
) {
    console.log('[e2e] node-pty was rebuilt without its ConPTY files — running its post-install');
    execFileSync(process.execPath, [path.join(nodePty, 'scripts', 'post-install.js')], {
        cwd: nodePty,
        stdio: 'inherit',
    });
    if (!fs.existsSync(conptyDll)) {
        throw new Error(
            `[e2e] node-pty still has no ConPTY support files at ${conptyDll} — every terminal would fail to spawn`,
        );
    }
}
