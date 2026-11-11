#!/usr/bin/env node
/**
 * WHAT THE WINDOWS INSTALL DIRECTORY SHOULD NOT HOLD, AND WHAT IT MUST.
 *
 *   node scripts/packed-tree-check.mjs <win-unpacked dir> [--arch x64]
 *
 * Reads the packaged tree; runs nothing in it. Exits 1, listing each file, if the tree holds a file the app never uses
 * at runtime on this platform and arch, or lacks one it does.
 *
 * Why (Tynn #437): v2.0.0-beta.60's installer put 220 files outside app.asar, and most were node-pty's and fancy-pty's
 * build leftovers: the binaries for macOS, Linux and Windows on Arm, winpty's sources and build scripts (.bat, .ps1,
 * .py, .sh), node-pty's TypeScript sources and its tests. Antivirus reads every one of them in the install directory,
 * the scripts and other platforms' binaries are what it looks at hardest, and none of them is ever loaded.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const UNPACKED = 'resources/app.asar.unpacked/node_modules/';
const NODE_PTY = `${UNPACKED}node-pty/`;
const FANCY_PTY = `${UNPACKED}@particle-academy/fancy-pty/`;
const PRISM_ACP = `${UNPACKED}@particle-academy/prism-acp/`;

/** Script and build-leftover extensions: none of them is ever run by the installed app. */
const LEFTOVER_EXT = /\.(ps1|bat|cmd|sh|py|pdb|tmp|bak|old|orig|gyp|gypi|h|c|cc|cpp|rs|ts)$/i;

/** Each file of `files` (paths relative to the install dir, `/`-separated) the app never uses on `platform`-`arch`, with why. */
export function leftovers(files, { platform = 'win32', arch = 'x64' } = {}) {
    const own = `${platform}-${arch}`;
    const out = [];
    for (const file of files) {
        let why = null;
        const prebuild = file.startsWith(`${NODE_PTY}prebuilds/`) && file.slice(`${NODE_PTY}prebuilds/`.length).split('/')[0];
        const helper = file.startsWith(`${FANCY_PTY}bin/`) && file.slice(`${FANCY_PTY}bin/`.length).split('/')[0];
        if (prebuild && prebuild !== own) why = `node-pty prebuild for ${prebuild}`;
        else if (helper && helper !== own) why = `fancy-pty helper for ${helper}`;
        else if (/^(deps|src|scripts|third_party)\//.test(file.startsWith(NODE_PTY) ? file.slice(NODE_PTY.length) : '')) why = 'node-pty build input';
        else if (file.startsWith(`${FANCY_PTY}native/`)) why = 'fancy-pty source';
        else if (/\.test\.js(\.map)?$/.test(file)) why = 'a test';
        else if (file.startsWith(UNPACKED) && /(^|\/)(Makefile|configure)$/.test(file)) why = 'a build script';
        else if (LEFTOVER_EXT.test(file) && !/\.d\.c?ts$/.test(file)) why = 'a script or build leftover';
        if (why) out.push({ file, why });
    }
    return out;
}

/** What the installed app loads on `platform`-`arch` (Windows only): every one must be in `files`. */
export function required({ platform = 'win32', arch = 'x64' } = {}) {
    if (platform !== 'win32') return [];
    const own = `${platform}-${arch}`;
    return [
        'Genie.exe',
        'resources/app.asar',
        'resources/bin/genie-launch.exe',
        ...['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty.dll', 'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
            .map((f) => `${NODE_PTY}prebuilds/${own}/${f}`),
        `${NODE_PTY}build/Release/conpty/conpty.dll`,
        `${NODE_PTY}build/Release/conpty/OpenConsole.exe`,
        `${NODE_PTY}lib/index.js`,
        `${NODE_PTY}lib/worker/conoutSocketWorker.js`,
        `${NODE_PTY}lib/conpty_console_list_agent.js`,
        `${FANCY_PTY}bin/${own}/fancy-pty-helper.exe`,
        `${UNPACKED}@napi-rs/keyring-${own}-msvc/keyring.${own}-msvc.node`,
        // Both architectures whatever this build's (Tynn #575): prism-acp picks by the machine, so x64 Genie on ARM64 Windows runs the ARM64 one.
        `${PRISM_ACP}native/win32-x64/prism-acp-supervisor.exe`,
        `${PRISM_ACP}native/win32-arm64/prism-acp-supervisor.exe`,
    ];
}

function walk(dir) {
    const out = [];
    for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else out.push(p);
    }
    return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
    const args = process.argv.slice(2);
    const root = args[0];
    const arch = args.includes('--arch') ? args[args.indexOf('--arch') + 1] : 'x64';
    const files = walk(root).map((p) => relative(root, p).replace(/\\/g, '/'));
    const extra = leftovers(files, { platform: 'win32', arch });
    const have = new Set(files);
    const missing = required({ platform: 'win32', arch }).filter((f) => !have.has(f));
    console.log(`### packed-tree-check: ${files.length} files; ${extra.length} the app never uses; ${missing.length} it needs and lacks`);
    for (const { file, why } of extra) console.log(`### NOT USED  ${file}  (${why})`);
    for (const file of missing) console.log(`### MISSING   ${file}`);
    if (extra.length || missing.length) process.exit(1);
}
