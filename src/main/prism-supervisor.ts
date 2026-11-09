import { execFile } from 'node:child_process';
import { readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { prepareProcessTree, supervisorPath } from '@particle-academy/prism-acp';
import { resolveProgram } from '../core/program-lookup.js';
import { setSupervisorExecutable } from '../core/supervisor-failure.js';

const PARENT = 'prism-supervisor';

/** The real file of a path inside the app's archive: `app.asar` is where it was packed, `app.asar.unpacked` is where it is. */
export function unpackedSupervisorPath(path: string): string {
    return path.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

/**
 * THE SUPERVISOR IS PREBUILT AND SIGNED WITH THE APP (Tynn #575). prism-acp 0.41 ships one for each architecture; nothing is
 * compiled or written on this machine any more. Its absolute unpacked path goes to prepareProcessTree once, at startup,
 * before any provider launches; prism-acp checks the file against its pin on every use. Windows only: elsewhere `null`.
 */
export async function prepareGenieSupervisor(): Promise<string | null> {
    if (process.platform !== 'win32') return null;
    const executable = unpackedSupervisorPath(supervisorPath());
    setSupervisorExecutable(executable);
    await prepareProcessTree({ executable });
    return executable;
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
 * but `current`, when one is given — every build earlier Genies compiled here (Tynn #575: none is compiled any more). ONLY
 * that folder: a `current` must be one of its entries, or nothing is touched. An entry that a running process was started
 * from is kept (a supervisor of a Genie still running, for one); a listing that cannot be read removes nothing, never
 * read as "nothing is running". The listing is taken only when there is something to remove.
 */
export async function removeStaleSupervisorBuilds(
    runtime: string,
    options: { current?: string; runningImages: () => Promise<readonly string[] | null> },
): Promise<StaleSweep> {
    const parent = resolve(runtime, PARENT);
    const current = options.current === undefined ? null : resolve(options.current);
    if (current !== null && (!samePath(dirname(current), parent) || relative(parent, current) === '')) {
        throw new Error(`the current supervisor folder is not in ${parent}`);
    }
    let names: string[];
    try {
        names = await readdir(parent);
    } catch {
        return { removed: [], running: [], failed: [], unread: false };
    }
    const stale = names.filter((n) => current === null || !samePath(n, basename(current))).map((n) => join(parent, n));
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
        const { stdout } = await execFileAsync(resolveProgram('powershell'), ['-NoProfile', '-NonInteractive', '-Command', WIN32_IMAGES], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        const images = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
        // Genie itself is always running: a listing without it is not a reading.
        return images.some((p) => samePath(p, process.execPath)) ? images : null;
    } catch {
        return null;
    }
}
