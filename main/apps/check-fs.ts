/**
 * The REAL filesystem behind the Genie App check (genie#245 follow-on).
 *
 * `checkApp` is pure and takes a probe, so every branch of it is asserted directly
 * rather than depending on what happens to be on the box running the tests. This is
 * the other side of that seam — and it lives in one module, used by the IPC handler,
 * the CLI and the fixture suite alike, because three copies of "walk a folder" is
 * three chances for the check a developer runs to disagree with the one Genie runs.
 *
 * No Electron here on purpose: the CLI has no Electron to run in.
 *
 * ## The caps are the interesting part
 *
 * A front-end repo contains `node_modules`, and walking it would take minutes to
 * find nothing — a suite that slow is one nobody runs twice, which is the same as
 * not having written it. So the walk skips what cannot be the app's own code, stops
 * at a depth and a count, and refuses to read a file too large to be source.
 *
 * They are I/O policy, so they live here rather than in the pure module: a fake
 * that had to reproduce them would be a second implementation of the thing under
 * test.
 */

import fs from 'fs';
import path from 'path';
import { APP_MANIFEST_FILENAME } from './manifest';
import type { CheckProbe } from './checkup';

/** Folders that cannot hold the app's own source, whatever the app is. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    '.cache',
    '.venv',
    'venv',
    '__pycache__',
    'vendor',
    '.next',
    '.nuxt',
    'coverage',
]);

/** Deep enough for any real front end, shallow enough to stay instant. */
const MAX_DEPTH = 12;
/** A cap that only a directory nobody meant to scan can reach. */
const MAX_FILES = 5000;
/** Above this, it is a bundle of assets rather than something to read. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

function walk(dir: string, depth: number, out: string[]): void {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        // Unreadable is EMPTY, never a crash: a permission-denied folder must not
        // take the whole report down with it.
        return;
    }
    for (const entry of entries) {
        if (out.length >= MAX_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(full, depth + 1, out);
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
}

export interface CheckFsOptions {
    /**
     * Is ANOTHER installed app already serving this slug?
     *
     * Injected because the answer lives in Genie's database, which the CLI has no
     * business opening — it answers "no" and says so, rather than pretending to
     * know. The Genie-side caller passes the real one.
     */
    slugTaken: (slug: string, selfId: string) => boolean;
}

export function fsCheckProbe(options: CheckFsOptions): CheckProbe {
    return {
        readManifest: (folder) => {
            const file = path.join(folder, APP_MANIFEST_FILENAME);
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        },
        exists: (p) => fs.existsSync(p),
        slugTaken: options.slugTaken,
        listFiles: (dir) => {
            const out: string[] = [];
            walk(dir, 0, out);
            return out;
        },
        readText: (file) => {
            try {
                if (fs.statSync(file).size > MAX_TEXT_BYTES) return null;
                return fs.readFileSync(file, 'utf8');
            } catch {
                // Missing, a directory, or not readable as text. All three mean
                // "nothing to scan", and none of them is worth failing a check over.
                return null;
            }
        },
    };
}
