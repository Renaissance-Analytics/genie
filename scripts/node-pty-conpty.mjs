// node-pty's ConPTY support files, and putting them back after a native rebuild.
//
// THE DEFECT. On Windows, node-pty spawns through ConPTY (fancy-term-host always
// passes `useConptyDll: true`), which needs `conpty.dll` + `OpenConsole.exe` in a
// `conpty/` folder BESIDE the binding it loaded. Those two are not compiled —
// node-pty's own `postinstall` COPIES them out of its vendored `third_party/`.
//
// `electron-builder install-app-deps` (our postinstall) drives @electron/rebuild,
// which calls node-gyp DIRECTLY and runs no npm lifecycle scripts. `node-gyp
// rebuild` cleans `build/` first, so a rebuild that SUCCEEDS — every machine with
// the C++ toolchain, which is exactly what we ask Windows developers to install —
// leaves a fresh `build/Release/pty.node` and no `conpty/` beside it. node-pty's
// loader prefers `build/Release` over the shipped `prebuilds/` that still has
// them, so every spawn then throws `Cannot find conpty.dll` and NOTHING can open a
// terminal.
//
// It is silent until something tries. The PACKAGED app has been protected since
// genie #14 (electron-builder.yml `afterPack` → fancy-term-host's per-OS fix), but
// that hook only runs when packaging — so the SOURCE tree, which is what
// `npm run dev` and the E2E suite run against, was never covered. The Windows E2E
// leg proved it: panels mounted, xterms mounted, and main holding no pty at all.
//
// THE REPAIR is node-pty's OWN post-install script, not a hand-rolled copy: it
// knows its arch mapping and which vendored ConPTY version it ships, and a second
// copy of that knowledge here would rot the moment either changes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * PURE. Does this tree need the repair?
 *
 * Only on Windows (ConPTY is Windows-only), only when something has produced a
 * `build/Release` (an untouched install loads from `prebuilds/`, which is intact),
 * and only when the dll is actually missing — so a correctly-installed tree is
 * left alone and the repair never runs twice.
 */
export function needsConptyRestore({ platform, hasBuildRelease, hasConptyDll }) {
    if (platform !== 'win32') return false;
    if (!hasBuildRelease) return false;
    return !hasConptyDll;
}

/** Where the loader looks for the dll, given a node-pty package directory. */
export function conptyDllPath(nodePtyDir) {
    return path.join(nodePtyDir, 'build', 'Release', 'conpty', 'conpty.dll');
}

/**
 * Restore node-pty's ConPTY files if a rebuild has dropped them.
 *
 * Returns `'not-needed'` when the tree is fine (or is not Windows), `'restored'`
 * when the repair ran and took. Throws only when the repair ran and did NOT take —
 * a state worth stopping for, since every terminal would fail to spawn.
 */
export function restoreNodePtyConpty(repoRoot, log = console.log) {
    const nodePty = path.join(repoRoot, 'node_modules', 'node-pty');
    const dll = conptyDllPath(nodePty);
    const needs = needsConptyRestore({
        platform: process.platform,
        hasBuildRelease: fs.existsSync(path.join(nodePty, 'build', 'Release')),
        hasConptyDll: fs.existsSync(dll),
    });
    if (!needs) return 'not-needed';

    log('[node-pty] rebuilt without its ConPTY files — running node-pty post-install');
    execFileSync(process.execPath, [path.join(nodePty, 'scripts', 'post-install.js')], {
        cwd: nodePty,
        stdio: 'inherit',
    });
    if (!fs.existsSync(dll)) {
        throw new Error(
            `[node-pty] still has no ConPTY support files at ${dll} — every terminal would fail to spawn`,
        );
    }
    return 'restored';
}
