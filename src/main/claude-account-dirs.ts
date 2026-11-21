import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ONE SESSION STORE FOR EVERY CLAUDE ACCOUNT (Tynn #1011). Each account Genie adds signs in to a configuration directory of its
 * own (credentials stay apart), and that directory's session history is a link to ONE store, the default home's `projects`,
 * so a thread resumes under whichever account is active.
 *
 * MEASURED, not assumed (scripts/probes/claude-shared-store-probe.sh, Claude Code 2.1.330 on the Linux test VM, Azure jobs
 * 1121-173755-fb8c72 and 1121-174416-6e0d49): a thread started under directory A resumed under B with its history; B's
 * requests carried B's credential only; B's run opened nothing under A (strace, with positive controls); a directory with a
 * real `projects` of its own could not resume it. `--resume` reads only `projects/` (the transcript, its per-session folder and
 * the project's `memory/`); `sessions/` holds per-process key files and stays per directory.
 *
 * This is the one function that links; prism-acp is to own it (`claudeAccounts.prepare(configDir, { sharedSessions: true })`),
 * and it is swapped in here when published. Rules: only session-history folders; never a credential-bearing one; a REAL folder
 * already there is refused, never replaced; a link pointing elsewhere is refused; a junction on Windows (no privilege needed),
 * a directory symlink elsewhere; no file's contents are ever read.
 */
export const SHARED_SESSION_FOLDERS: readonly string[] = ['projects'];

/** The only filesystem calls this makes: none reads a file's contents. */
export interface SessionLinkFs {
    mkdir(path: string): void;
    /** `null` when nothing is there. */
    lstat(path: string): { isSymbolicLink(): boolean } | null;
    readlink(path: string): string;
    symlink(target: string, path: string, type: 'junction' | 'dir'): void;
}

const realFs: SessionLinkFs = {
    mkdir: (path) => { mkdirSync(path, { recursive: true }); },
    lstat: (path) => lstatSync(path, { throwIfNoEntry: false }) ?? null,
    readlink: (path) => readlinkSync(path),
    symlink: (target, path, type) => { symlinkSync(target, path, type); },
};

/** Paths compared as the OS does: resolved, and case-insensitively on Windows. A junction reads back with a trailing separator. */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
    const norm = (p: string) => { const r = resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, ''); return platform === 'win32' ? r.toLowerCase() : r; };
    return norm(a) === norm(b);
}

export function linkSharedSessions(configDir: string, store: string, options: { fs?: SessionLinkFs; platform?: NodeJS.Platform } = {}): { ok: true } | { ok: false; reason: string } {
    const fs = options.fs ?? realFs;
    const platform = options.platform ?? process.platform;
    try {
        fs.mkdir(configDir);
        fs.mkdir(store);
        for (const name of SHARED_SESSION_FOLDERS) {
            const path = join(configDir, name);
            const there = fs.lstat(path);
            if (there === null) { fs.symlink(resolve(store), path, platform === 'win32' ? 'junction' : 'dir'); continue; }
            if (!there.isSymbolicLink()) return { ok: false, reason: `The account folder already has its own "${name}" folder, so its conversations cannot be shared. Genie leaves it as it is.` };
            if (!samePath(fs.readlink(path), store, platform)) return { ok: false, reason: `The account folder's "${name}" links somewhere else, so Genie leaves it as it is.` };
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: `The account folder could not be prepared: ${error instanceof Error ? error.message : String(error)}` };
    }
}
