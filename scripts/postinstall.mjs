// npm postinstall, in two steps.
//
// 1. `electron-builder install-app-deps` — rebuild native modules against
//    ELECTRON's ABI rather than the host node's. Tolerated when it fails: a
//    Windows machine without VS Build Tools cannot compile node-pty, and that is
//    fine for day-to-day work (the shipped prebuilds match), so a missing
//    toolchain must not fail `npm install`.
//
// 2. Put node-pty's ConPTY files back if step 1 took them away. See
//    ./node-pty-conpty.mjs for the full mechanism; the short version is that
//    `node-gyp rebuild` cleans `build/`, node-pty's own postinstall (which COPIES
//    conpty.dll in) is not re-run by @electron/rebuild, and its loader then
//    prefers the incomplete `build/Release` over the intact `prebuilds/`. On
//    Windows every terminal fails to spawn, silently, until something tries one.
//
// The repair belongs HERE, immediately after the thing that causes the damage,
// rather than in each consumer: the packaged app has had its own fix since
// genie #14 (electron-builder.yml `afterPack`), but that hook only runs when
// packaging — so `npm run dev` and the E2E suite, which run against the SOURCE
// tree, had nothing.
//
// This script must not throw for an ordinary reason. It runs on every install,
// for everyone.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreNodePtyConpty } from './node-pty-conpty.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Invoke electron-builder's JS entry through `node` rather than the `.bin` shim:
// Node's execFileSync cannot spawn a Windows `.cmd` directly (EINVAL), and this
// is shell-free and cross-platform.
//
// Resolution is inside the same try as the run. electron-builder is a DEV
// dependency, so a production/`--omit=dev` install has none — and the shell form
// this replaced degraded to its `|| echo` message there rather than failing the
// install. Keep that: a postinstall that throws is an install that fails.
try {
    const ebPkgPath = path.join(root, 'node_modules', 'electron-builder', 'package.json');
    const ebPkg = require(ebPkgPath);
    const ebEntry =
        typeof ebPkg.bin === 'string' ? ebPkg.bin : ebPkg.bin['electron-builder'];
    execFileSync(process.execPath, [path.join(path.dirname(ebPkgPath), ebEntry), 'install-app-deps'], {
        cwd: root,
        stdio: 'inherit',
    });
} catch {
    console.log(
        'native rebuild skipped — using bundled prebuilds (install VS Build Tools on Windows for ABI-clean release builds)',
    );
}

try {
    restoreNodePtyConpty(root);
} catch (err) {
    // Loud, but never fatal to an install: a tree that cannot be repaired is a
    // tree whose terminals will not spawn, and the person needs to KNOW that —
    // but finding out at `npm install` time by having the install fail helps
    // nobody, and the E2E prep step gates on it properly.
    console.warn(`\n${err instanceof Error ? err.message : String(err)}\n`);
}
