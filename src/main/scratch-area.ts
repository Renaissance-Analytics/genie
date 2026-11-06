import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { lstat, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { systemProcessTree, type ProcessInfo } from '../core/process-tree.js';
import { scratchDir } from './paths.js';

/**
 * GENIE'S SCRATCH (the host split, P7: "every path from the one root"): `<root>/cache/tmp`, never the OS temp folder.
 *
 * The shape is local staging's (local-staging-area.ts): one folder per process, `<pid>-<started>`, and the folders of
 * processes that are gone removed after start. What differs is WHEN the process table is read. #1595 measured a cold
 * Windows process-table read at 2.8 s and took it off startup; a login's click must not wait for one either. So this
 * process's folder is made at once, by name, with no table read, and the sweep is deferred (`scheduleScratchSweep`),
 * cancelled on shutdown.
 *
 * A folder is removed only when NO process has its pid. A pid reused by another process keeps a gone folder until that
 * one ends too: a leak at worst, never a live process's folder removed.
 *
 * Private as the OS temp's `mkdtemp` was: 0700 on POSIX; on Windows the folder inherits the ACL of the person's profile,
 * as `%TEMP%` does. Nothing secret is written here: a provider's login keeps its credential in the CLI's own home.
 */

type ProcessReader = () => Promise<readonly ProcessInfo[] | null>;
const readProcesses: ProcessReader = async () => (await systemProcessTree.read?.()) ?? null;
const OWNER = /^([1-9][0-9]*)-([1-9][0-9]*)$/;

export interface ScratchArea {
    /** `<root>/cache/tmp`. */
    readonly root: string;
    /** This process's folder under it, made on first ask (no process-table read), the same folder after. */
    directory(): string;
}

function privateDirectory(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Genie’s scratch needs its own real folder');
    if (process.platform !== 'win32') chmodSync(path, 0o700);
}

/** This process's start, in ms, to name its folder; the sweep goes by the pid. */
function startedMs(): number {
    return Math.max(1, Math.round(Date.now() - process.uptime() * 1000));
}

export function scratchArea(root: string, own: { pid: number; started: number } = { pid: process.pid, started: startedMs() }): ScratchArea {
    const base = scratchDir(root);
    const directory = join(base, `${own.pid}-${own.started}`);
    let made = false;
    return {
        root: base,
        directory: () => {
            if (!made) { privateDirectory(base); privateDirectory(directory); made = true; }
            return directory;
        },
    };
}

/** Removes the folders of processes that are gone. Reads the process table once; with none, removes nothing. */
export async function sweepOldScratch(root: string, deps: { readProcesses?: ProcessReader; signal?: AbortSignal; pid?: number } = {}): Promise<void> {
    if (deps.signal?.aborted) return;
    const base = scratchDir(root);
    const entries = await readdir(base, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (entries === null) return;
    const own = deps.pid ?? process.pid;
    const candidates = entries.filter((e) => {
        const m = OWNER.exec(e.name);
        return m !== null && Number(m[1]) !== own && (e.isDirectory() || e.isSymbolicLink());
    });
    if (candidates.length === 0 || deps.signal?.aborted) return;
    const table = await (deps.readProcesses ?? readProcesses)();
    if (table === null || deps.signal?.aborted) return;
    const alive = new Set(table.map((p) => p.pid));
    for (const entry of candidates) {
        if (deps.signal?.aborted) return;
        if (alive.has(Number(OWNER.exec(entry.name)![1]))) continue;
        const path = join(base, entry.name);
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (deps.signal?.aborted) return;
        if (info?.isSymbolicLink()) await unlink(path);
        else if (info?.isDirectory()) await rm(path, { recursive: true, force: true });
    }
}

/**
 * The sweep, deferred off the start path; the returned stop (call it on quit) cancels it, and a sweep already running
 * stops before its next removal.
 */
export function scheduleScratchSweep(
    root: string,
    deps: { schedule?: (work: () => Promise<void>) => () => void; readProcesses?: ProcessReader; pid?: number; log?: (line: string) => void } = {},
): () => void {
    const stopped = new AbortController();
    const work = async (): Promise<void> => {
        if (stopped.signal.aborted) return;
        await sweepOldScratch(root, { signal: stopped.signal, ...(deps.readProcesses ? { readProcesses: deps.readProcesses } : {}), ...(deps.pid !== undefined ? { pid: deps.pid } : {}) })
            .catch((error: unknown) => { if (!stopped.signal.aborted) (deps.log ?? console.warn)(`[genie] old scratch could not be swept: ${error instanceof Error ? error.message : String(error)}`); });
    };
    const cancel = deps.schedule ? deps.schedule(work) : (() => {
        const timer = setTimeout(() => { void work(); }, 0);
        timer.unref();
        return () => clearTimeout(timer);
    })();
    return () => { stopped.abort(); cancel(); };
}
