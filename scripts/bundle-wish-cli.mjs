#!/usr/bin/env node
/**
 * Refresh the vendored wish-cli snapshot under `resources/wish-cli/`.
 *
 * Genie's Release CI checks out the genie repo ALONE (no envelope, no
 * tynn-cli submodule), so the wish-cli toolkit can't be copied at build time —
 * it must be COMMITTED into genie's repo. This script is the dev-time refresh
 * tool: run it from inside the `.agi` envelope (where `../tynn-cli` exists) to
 * re-vendor the latest toolkit, then commit the result.
 *
 * Outside the envelope (CI, a standalone genie clone) the source isn't present,
 * so this no-ops and the already-committed snapshot stands.
 *
 *   node scripts/bundle-wish-cli.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const genieRoot = path.resolve(here, '..');
// genie lives at <envelope>/repos/genie; tynn-cli at <envelope>/repos/tynn-cli.
const source = path.resolve(genieRoot, '..', 'tynn-cli');
const dest = path.join(genieRoot, 'resources', 'wish-cli');

// What we ship: the executable toolkit + its libs + the config TEMPLATE (the
// real tynn.config is user-specific and gitignored upstream; the tools treat a
// missing config as "all stacks allowed", so the template alone works).
const ITEMS = [
    'bin',
    'lib',
    'install.sh',
    'tynn.config.example',
    'README.md',
    'STACKS.md',
    'LICENSE',
];

if (!fs.existsSync(source)) {
    console.log(
        `[bundle-wish-cli] source not found at ${source} — keeping the committed snapshot (CI/standalone build).`,
    );
    process.exit(0);
}

function copyRecursive(src, dst) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dst, entry));
        }
    } else {
        fs.copyFileSync(src, dst);
    }
}

// Clean the vendored copy of the items we manage (leave a stray README etc.
// from a prior layout untouched only if not in ITEMS — but our set is stable).
fs.mkdirSync(dest, { recursive: true });
for (const item of ITEMS) {
    const srcPath = path.join(source, item);
    const dstPath = path.join(dest, item);
    if (!fs.existsSync(srcPath)) {
        console.warn(`[bundle-wish-cli] skip missing ${item}`);
        continue;
    }
    fs.rmSync(dstPath, { recursive: true, force: true });
    copyRecursive(srcPath, dstPath);
}

// A small marker so the app + a human can tell where the snapshot came from.
fs.writeFileSync(
    path.join(dest, 'BUNDLED.txt'),
    `Vendored from repos/tynn-cli by scripts/bundle-wish-cli.mjs.\nDo not edit here — edit tynn-cli and re-run the bundler.\n`,
);

console.log(`[bundle-wish-cli] refreshed ${dest} from ${source}`);
