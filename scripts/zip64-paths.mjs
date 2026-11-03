#!/usr/bin/env node
/**
 * WHAT THE ZIP64 CHECK IS ABOUT: the files whose change can change how a tree past 65,535 entries is written.
 *
 * CI's `zip64 acceptance` job runs `npm run verify:zip64` only when a change touches them, the way `flows acceptance` does for Flows (scripts/flows-paths.mjs). The writer is whatever under src/
 * imports yazl, read on the commit being tested, so one that moves or a second one joins by itself. folder-zip.ts is named as well, so that deleting it runs the check rather than skipping it.
 * test/zip64-acceptance-ci.test.ts holds the rules.
 *
 * Usage:
 *   node scripts/zip64-paths.mjs                      the writers, one path per line
 *   node scripts/zip64-paths.mjs --touched <file>     of the paths listed in <file> (one per line, as `git diff --name-only` prints them), the ones that touch it; nothing when none do
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { srcFiles } from './flows-paths.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A prefix ending in / is a directory. */
export const ALSO = ['src/main/folder-zip.ts', 'test/zip64-acceptance/', 'vitest.zip64.config.mts', 'scripts/zip64-paths.mjs'];

const IMPORTS_YAZL = /^\s*(?:import|export)\b[^;]*?from\s+['"]yazl['"]|^\s*import\s+['"]yazl['"]|\bimport\(\s*['"]yazl['"]\s*\)|\brequire\(\s*['"]yazl['"]\s*\)/m;

export function zipWriters(root = REPO) {
    return srcFiles(root).filter((file) => IMPORTS_YAZL.test(readFileSync(join(root, file), 'utf8')));
}

export function touchedZip64(changed, root) {
    const writers = new Set(zipWriters(root));
    return changed.map((p) => p.trim()).filter((p) => p && (writers.has(p) || ALSO.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a))));
}

// Run as a script (not imported by the test): by name, since comparing full paths trips over a drive letter's case.
if (/(^|[\\/])zip64-paths\.mjs$/.test(process.argv[1] ?? '')) {
    const [flag, list] = process.argv.slice(2);
    if (flag === '--touched') {
        if (!list) { console.error('usage: zip64-paths.mjs --touched <file of changed paths>'); process.exit(2); }
        const hits = touchedZip64(readFileSync(list, 'utf8').split(/\r?\n/));
        if (hits.length) console.log(hits.join('\n'));
    } else if (flag === undefined) {
        console.log(zipWriters().join('\n'));
    } else {
        console.error(`unknown argument ${flag}`);
        process.exit(2);
    }
}
