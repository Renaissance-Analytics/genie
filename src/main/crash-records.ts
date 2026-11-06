import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { CRASH_KEEP, LIFECYCLE_TAIL_LINES, fitCrashRecord, type CrashRecord } from '../core/crash-record.js';

/**
 * THE CRASH RECORDS ON DISK (Tynn story #386): `<genieRoot()>/runtime/crash/<ISO time>.json`, written by genie-host for
 * a hang or a lost window and by window main on each exit path it can catch.
 *
 * Synchronous — the paths that write them are where a process is about to end, and `process.on('exit')` runs nothing
 * asynchronous — and never throwing: a crash record that fails must not become a second crash. Bounded: the newest
 * {@link CRASH_KEEP} records are kept, each file under 256 KB (core/crash-record.ts `fitCrashRecord`).
 *
 * The file name is the record's time with `:` as `-` (Windows refuses a colon in a file name), so names sort as times.
 */

const RECORD = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(-\d+)?\.json$/;

/** Writes one record; answers its file, or `null` when it could not be written. Removes the oldest past the cap. */
export function writeCrashRecord(dir: string, record: CrashRecord): string | null {
    try {
        mkdirSync(dir, { recursive: true });
        const text = fitCrashRecord(record);
        const stem = record.at.replace(/:/g, '-');
        let file: string | null = null;
        for (let n = 0; n < 50 && file === null; n++) {
            const candidate = join(dir, n === 0 ? `${stem}.json` : `${stem}-${n}.json`);
            let fd: number;
            try {
                fd = openSync(candidate, 'wx');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
                throw error;
            }
            try { writeSync(fd, text); } finally { closeSync(fd); }
            file = candidate;
        }
        pruneCrashRecords(dir, CRASH_KEEP);
        return file;
    } catch {
        return null;
    }
}

/** The records in `dir`, oldest first (by name = by time). Anything that is not a record is not one of them. */
function recordNames(dir: string): string[] {
    try {
        return readdirSync(dir).filter((name) => RECORD.test(name)).sort(byTime);
    } catch {
        return [];
    }
}

/** By time, and within one millisecond by the suffix: `x.json` before `x-1.json` before `x-2.json`. */
function byTime(a: string, b: string): number {
    const key = (name: string): [string, number] => {
        const m = /^(.*?Z)(?:-(\d+))?\.json$/.exec(name);
        return m ? [m[1]!, m[2] === undefined ? 0 : Number(m[2])] : [name, 0];
    };
    const [ta, na] = key(a);
    const [tb, nb] = key(b);
    return ta < tb ? -1 : ta > tb ? 1 : na - nb;
}

/** Keeps the newest `keep` records. */
export function pruneCrashRecords(dir: string, keep: number): void {
    const names = recordNames(dir);
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
        try { rmSync(join(dir, name), { force: true }); } catch { /* the next write tries again */ }
    }
}

/** Takes a record back (a before-quit whose quit then ran to its end). Never throws. */
export function removeCrashRecord(file: string): void {
    try { rmSync(file, { force: true }); } catch { /* left: the next start reads an unclean quit, which is the safe reading */ }
}

/** The newest record in `dir`, or `null`. */
export function latestCrashRecord(dir: string): CrashRecord | null {
    const names = recordNames(dir);
    for (let i = names.length - 1; i >= 0; i--) {
        try {
            const value = JSON.parse(readFileSync(join(dir, names[i]!), 'utf8')) as { kind?: unknown };
            if (value && (value.kind === 'hang' || value.kind === 'lost' || value.kind === 'exit')) return value as CrashRecord;
        } catch { /* a torn file: the one before it */ }
    }
    return null;
}

/** The cause of the run that did not end cleanly, from its records (Tynn #386). Not built yet. */
export function previousRunCause(_dir: string, _startedAt: number | null): string {
    throw new Error('not built yet (Tynn #386)');
}

/** How much of the end of a log file is read for its last lines: 200 lines are far less. */
const TAIL_BYTES = 256 * 1024;

function tailLines(file: string): string[] {
    try {
        const text = readFileSync(file, 'utf8');
        const end = text.length > TAIL_BYTES ? text.slice(text.length - TAIL_BYTES) : text;
        const lines = end.split(/\r?\n/).filter((l) => l.length > 0);
        // A cut in the middle of a line: its first part is not a line.
        if (text.length > TAIL_BYTES) lines.shift();
        return lines;
    } catch {
        return [];
    }
}

/** The last {@link LIFECYCLE_TAIL_LINES} lines of `<runtime>/lifecycle.log`, reaching into `lifecycle.log.1` (its rotation) when the live file has fewer. */
export function readLifecycleTail(runtime: string, n: number = LIFECYCLE_TAIL_LINES): string[] {
    const live = tailLines(join(runtime, 'lifecycle.log'));
    if (live.length >= n) return live.slice(-n);
    const older = tailLines(join(runtime, 'lifecycle.log.1'));
    return [...older, ...live].slice(-n);
}
