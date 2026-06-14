/**
 * Working-directory normalisation for PTY spawns.
 *
 * OS-agnostic core util (only node:fs / node:os / process — no electron, no
 * db), so it lifts into the fancy-term-host package alongside the backend.
 *
 * Two problems it solves, both seen as Windows error 267 (ERROR_DIRECTORY,
 * "the directory name is invalid") when node-pty is handed a cwd it can't
 * chdir into:
 *
 *  1. Git Bash / MSYS report `$PWD` as `/c/Users/me`, not `C:\Users\me`. Our
 *     OSC-7 cwd hook emits that MSYS form, so a captured `live_cwd` like
 *     `/c/Users/me` is valid INSIDE bash but invalid as a Windows spawn cwd.
 *     `toNativeCwd` converts `/c/Users/me` → `C:\Users\me` on win32.
 *  2. A persisted cwd can simply no longer exist (folder moved/deleted).
 *     `resolveSpawnCwd` validates and falls back to home so terminal creation
 *     never hard-fails on a stale cwd.
 */
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';

/**
 * Convert an MSYS/Git-Bash style path (`/c/Users/me`) to a native Windows path
 * (`C:\Users\me`) on win32. No-op on other platforms and for already-native
 * paths.
 */
export function toNativeCwd(p: string): string {
    if (process.platform !== 'win32' || !p) return p;
    // "/c/Users/me" → "C:\Users\me"
    const m = /^\/([A-Za-z])\/(.*)$/.exec(p);
    if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
    // bare drive root "/c" or "/c/" → "C:\"
    const root = /^\/([A-Za-z])\/?$/.exec(p);
    if (root) return `${root[1].toUpperCase()}:\\`;
    return p;
}

/**
 * Resolve a usable spawn cwd: prefer the requested directory (native-converted),
 * and if it isn't an existing directory, fall back to the user's home dir.
 * Prevents node-pty from failing with ERROR_DIRECTORY on a stale/invalid cwd.
 */
export function resolveSpawnCwd(requested: string | undefined | null): string {
    if (requested) {
        const native = toNativeCwd(requested);
        try {
            if (existsSync(native) && statSync(native).isDirectory()) return native;
        } catch {
            /* fall through to home */
        }
    }
    return os.homedir();
}
