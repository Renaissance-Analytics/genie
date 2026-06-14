import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PROTOCOL_VERSION } from './host-protocol';

/**
 * Path + pidfile resolution for the detached pty-host (Tier 3).
 *
 * Kept ELECTRON-FREE on the resolution side that the host itself uses (the host
 * is a plain node process — no `app`), so the userData path is passed IN. The
 * in-app side (host-client lifecycle) imports `app` separately and feeds it here.
 */

export interface Pidfile {
    pid: number;
    socketPath: string;
    protocolVersion: number;
    startedAt: number;
}

/** Short, stable per-user hash so two OS users don't collide on the Windows
 *  pipe name (the pipe namespace is machine-global). */
export function userHash(): string {
    const seed = `${os.userInfo().username}|${os.hostname()}`;
    return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

/**
 * The local IPC transport address.
 *   • Windows: a named pipe `\\.\pipe\genie-ptyhost-<userhash>`. The default
 *     Windows pipe ACL is per-logon-session, so another user on the same machine
 *     can't open it — that's our ACL. (Documented; we don't tighten further.)
 *   • POSIX: a unix domain socket under userData (preferred — survives /tmp
 *     cleaners and is per-user by directory perms) named `ptyhost.sock`.
 */
export function socketPathFor(userDataDir: string): string {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\genie-ptyhost-${userHash()}`;
    }
    // Keep the path short — unix socket paths have a ~104-char limit. userData is
    // typically well under that; fall back to os.tmpdir() if it's pathologically
    // long.
    const candidate = path.join(userDataDir, 'ptyhost.sock');
    if (candidate.length < 100) return candidate;
    return path.join(os.tmpdir(), `genie-ptyhost-${userHash()}.sock`);
}

export function pidfilePath(userDataDir: string): string {
    return path.join(userDataDir, 'ptyhost.json');
}

export function writePidfile(userDataDir: string, pf: Pidfile): void {
    const target = pidfilePath(userDataDir);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pf));
    fs.renameSync(tmp, target);
}

export function readPidfile(userDataDir: string): Pidfile | null {
    try {
        const raw = fs.readFileSync(pidfilePath(userDataDir), 'utf8');
        const pf = JSON.parse(raw) as Pidfile;
        if (
            typeof pf.pid !== 'number' ||
            typeof pf.socketPath !== 'string' ||
            typeof pf.protocolVersion !== 'number'
        ) {
            return null;
        }
        return pf;
    } catch {
        return null;
    }
}

export function deletePidfile(userDataDir: string): void {
    try {
        fs.rmSync(pidfilePath(userDataDir), { force: true });
    } catch {
        /* ignore */
    }
}

/** True when a process with `pid` is alive (signal 0 probes without killing). */
export function isPidAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM = exists but not ours (still "alive"); ESRCH = gone.
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Decide whether an existing pidfile points at a usable host.
 * Usable = pid alive AND protocol versions match. A stale/dead/mismatched
 * pidfile means we must spawn a fresh host.
 */
export function pidfileUsable(pf: Pidfile | null): boolean {
    if (!pf) return false;
    if (pf.protocolVersion !== PROTOCOL_VERSION) return false;
    if (!isPidAlive(pf.pid)) return false;
    return true;
}

/**
 * Resolve the compiled pty-host script on disk, trying multiple candidate paths
 * so it works in BOTH `npm run dev` (script at app/pty-host.js next to
 * background.js) AND a packaged asar build. node-pty's native binding can't load
 * from inside an asar, so the host (which requires node-pty) must run UNPACKED —
 * `app.asar.unpacked/...`. We try the unpacked path first, then the in-asar path,
 * then a dev-relative path. Returns the first that exists, or null.
 *
 * `dirname` is main/background's __dirname (the directory the compiled main
 * bundle lives in). The host script is emitted alongside it as `pty-host.js`.
 */
export function resolveHostScript(dirname: string): string | null {
    const candidates = [
        // Packaged: node-pty must be unpacked, so run the host from the unpacked
        // tree too (its require('node-pty') resolves to the unpacked .node).
        dirname.includes(`app.asar${path.sep}`) || dirname.includes('app.asar/')
            ? dirname.replace(
                  /app\.asar([\\/])/,
                  `app.asar.unpacked$1`,
              ) + path.sep + 'pty-host.js'
            : '',
        // Same dir as the compiled main bundle (dev: app/pty-host.js).
        path.join(dirname, 'pty-host.js'),
        // Defensive: a sibling unpacked dir computed from the asar path.
        path.join(dirname.replace('app.asar', 'app.asar.unpacked'), 'pty-host.js'),
    ].filter(Boolean);

    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return c;
        } catch {
            /* keep trying */
        }
    }
    return null;
}
