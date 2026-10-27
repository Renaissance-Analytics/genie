import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { prepareProcessTree } from '@particle-academy/prism-acp';
// The C# prism-acp compiles its Windows supervisor from. The package exports no key for it and its `exports` admit only
// the root, so this is the module file itself — the same file prism-acp's own process-tree.js imports, so the bundle
// holds one copy and the key is of exactly what prism-acp builds. A prism-acp that moves it fails the build, loudly.
import { SUPERVISOR_CS } from '../../node_modules/@particle-academy/prism-acp/dist/process-tree-supervisor-cs.js';

/**
 * GENIE'S SUPERVISOR FOLDER IS KEYED BY THE SUPERVISOR'S SOURCE (genie#1259).
 *
 * prism-acp builds its Windows supervisor (a Job Object holder, and since 0.30 the exit adapter of a Claude agent's
 * approval hook) once, with csc, and before every launch checks the build against the hash recorded FOR THAT BUILD — not
 * against the source it would build now. Its own default folder is `%LOCALAPPDATA%/prism-acp/supervisor-<sha256 of the
 * source, 16 hex>`, so a release that changes the source builds again. Genie keeps it in its own runtime folder instead,
 * and that folder was fixed: a build an older prism-acp left there kept verifying after an upgrade. Measured on
 * genie-test-windows (2026-10-26): a 0.29 build stayed in use under 0.31, and having no approval mode it exited 125 as
 * the approval adapter of every Claude shell call. 0.32's new pointer layout forced one rebuild; the next release that
 * changes the source without changing the layout would have brought it back.
 *
 * So Genie's folder carries prism-acp's own key, computed the same way from the same source:
 * `<runtime>/prism-supervisor/supervisor-<key>`. A folder only ever holds builds of its own source, so a build from any
 * other source is never reused. (supervisor-cold-start-windows.test.ts checks that the key matches prism-acp's default.)
 */
const PARENT = 'prism-supervisor';

/** Genie's folder for prism-acp's Windows supervisor, keyed by the supervisor's source (by default, the one prism-acp builds). */
export function supervisorFolder(runtime: string, source: string = SUPERVISOR_CS): string {
    const key = createHash('sha256').update(source).digest('hex').slice(0, 16);
    return join(runtime, PARENT, `supervisor-${key}`);
}

/** Builds (or verifies) the supervisor in Genie's keyed folder before any agent starts; resolves to that folder. */
export async function prepareGenieSupervisor(runtime: string): Promise<string> {
    const folder = supervisorFolder(runtime);
    await prepareProcessTree({ directory: folder });
    return folder;
}

/** What a sweep of stale builds did. Every path is an entry directly inside `<runtime>/prism-supervisor`. */
export interface StaleSweep {
    readonly removed: readonly string[];
    /** Kept: a running process was started from it. */
    readonly running: readonly string[];
    /** Could not be removed (in use, permissions); kept, and tried again next boot. */
    readonly failed: readonly string[];
    /** The process listing could not be read, so nothing was removed. */
    readonly unread: boolean;
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (path: string, entry: string) => {
    const [p, e] = process.platform === 'win32' ? [path.toLowerCase(), entry.toLowerCase()] : [path, entry];
    return p === e || p.startsWith(e.endsWith(sep) ? e : e + sep);
};

/**
 * Removes what other supervisor sources left in Genie's supervisor folder: every entry of `<runtime>/prism-supervisor`
 * but `current` — the flat build of prism-acp ≤0.31, 0.32's pointer layout at the top level, other keys' folders. ONLY
 * that folder: `current` must be one of its entries, or nothing is touched. An entry that a running process was started
 * from is kept (a supervisor of a Genie still running, for one); a listing that cannot be read removes nothing, never
 * read as "nothing is running". The listing is taken only when there is something to remove.
 */
export async function removeStaleSupervisorBuilds(
    runtime: string,
    options: { current: string; runningImages: () => Promise<readonly string[] | null> },
): Promise<StaleSweep> {
    const parent = resolve(runtime, PARENT);
    const current = resolve(options.current);
    if (!samePath(dirname(current), parent) || relative(parent, current) === '') {
        throw new Error(`the current supervisor folder is not in ${parent}`);
    }
    let names: string[];
    try {
        names = await readdir(parent);
    } catch {
        return { removed: [], running: [], failed: [], unread: false };
    }
    const stale = names.filter((n) => !samePath(n, basename(current))).map((n) => join(parent, n));
    if (stale.length === 0) return { removed: [], running: [], failed: [], unread: false };
    const images = await options.runningImages();
    if (images === null) return { removed: [], running: [], failed: [], unread: true };
    // Matched by the folder's real path too: a listing names images by their long path, a runtime folder may not be one.
    const real = await realpath(parent).catch(() => parent);
    const removed: string[] = [];
    const running: string[] = [];
    const failed: string[] = [];
    for (const entry of stale) {
        const realEntry = join(real, basename(entry));
        if (images.some((image) => inside(resolve(image), entry) || inside(resolve(image), realEntry))) {
            running.push(entry);
            continue;
        }
        try {
            await rm(entry, { recursive: true, force: true });
            removed.push(entry);
        } catch {
            failed.push(entry);
        }
    }
    return { removed, running, failed, unread: false };
}

const execFileAsync = promisify(execFile);
// ExecutablePath is null for a process this user cannot query; such a process was not started by this Genie.
const WIN32_IMAGES = 'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { $_.ExecutablePath }';

/**
 * The executable of every process this user can see, or `null` when the listing could not be read. Windows only: the
 * supervisor is only ever built there, so elsewhere there is nothing in the folder to protect, and an empty list is true.
 */
export async function supervisorImagesRunning(): Promise<readonly string[] | null> {
    if (process.platform !== 'win32') return [];
    try {
        const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN32_IMAGES], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        const images = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
        // Genie itself is always running: a listing without it is not a reading.
        return images.some((p) => samePath(p, process.execPath)) ? images : null;
    } catch {
        return null;
    }
}
