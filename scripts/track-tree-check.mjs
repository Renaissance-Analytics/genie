#!/usr/bin/env node
/**
 * WHAT ONE PACKAGE HOLDS, AND MUST NOT (Tynn #1058 L3): the packed-tree row per package. Reads a laid-out tree; runs
 * nothing in it. Exits 1, naming each file, when the tree lacks a file its program needs or holds one it must not
 * (scripts/track-packages.mjs `trackTreeProblems`: a host with an app.asar or Tynn #437's leftovers; a client or browser
 * with host.js in its app.asar, a copy of the launcher, or Caddy).
 *
 *   node scripts/track-tree-check.mjs <trees dir> <client|browser|host|launcher> [--asar-files <asar-files.json>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackTreeProblems, treeOf } from './track-packages.mjs';

const [trees, track, ...rest] = process.argv.slice(2);
if (!trees || !['client', 'browser', 'host', 'launcher'].includes(track)) {
    console.error('usage: track-tree-check.mjs <trees dir> <client|browser|host|launcher> [--asar-files <file>]');
    process.exit(2);
}
const at = rest.indexOf('--asar-files');
const asarFiles = at >= 0 ? JSON.parse(readFileSync(rest[at + 1], 'utf8')) : [];
if (track === 'client' && asarFiles.length === 0) {
    console.error(`track-tree-check: the ${track}'s app.asar listing is needed (--asar-files): without it, host.js in the archive cannot be seen`);
    process.exit(2);
}
const platform = process.platform === 'win32' ? 'win32' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const files = await treeOf(join(trees, track));
const problems = trackTreeProblems({ track, platform, arch, files, asarFiles });
console.log(`### track-tree ${track} ${platform}-${arch}: ${files.length} files${asarFiles.length ? `, ${asarFiles.length} in its app.asar` : ''}; ${problems.length} problem(s)`);
for (const p of problems) console.log(`### ${p.why === 'missing' ? 'MISSING ' : 'NOT HERE'}  ${p.file}${p.why === 'missing' ? '' : `  (${p.why})`}`);
if (problems.length) process.exit(1);
