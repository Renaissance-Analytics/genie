import { closeSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';

/**
 * WHAT A PROCESS INHERITED FROM ITS PARENT, AND LETTING GO OF IT (batch L4, bug A; measured on omarchy-test, VM job 76).
 *
 * Electron's window holds Chromium's sockets and pipes WITHOUT close-on-exec — its DevTools listener (:9222) among them —
 * and the genie-host it spawned held every one of them (fd 41/42, 47, 51, 52, 53, 65, 68, 69), and handed them on to its
 * spawn hosts, the fancy-pty helper and the shell. A host left running, or a helper it left behind, then kept the
 * window's port open: it ACCEPTED connections and nobody answered.
 *
 * So at startup, before any module of the process opens anything, every SOCKET or PIPE at fd 3 or above that was INHERITED
 * is closed. Inherited, by either sign: it carries no O_CLOEXEC (every fd Node and libuv open has it, and on the VM the host
 * had no socket or pipe of its own without it), or the parent holds the very same one, by inode (CI measured the parent's
 * listener arriving FLAGGED close-on-exec in the host, so the flag alone would have kept it). Kept: stdio, files (none holds
 * a port or a pipe end open, and Electron may hold its own data files), other kinds (eventfd, epoll), this process's own
 * (close-on-exec, and not the parent's), and Node's IPC channel (NODE_CHANNEL_FD, inherited on purpose by a forked spawn
 * host). Linux reads /proc; elsewhere nothing is closed here.
 */
export const O_CLOEXEC = 0o2000000;

export interface FdInfo {
    /** `flags:` from /proc/self/fdinfo (octal parsed). */
    readonly flags: number;
    /** What /proc/self/fd/<fd> links to: `socket:[N]`, `pipe:[N]`, a path, `anon_inode:[…]`. */
    readonly target: string;
}

/**
 * The fds to close: ≥ 3, not kept, a socket or a pipe — and INHERITED, by either sign: it carries no O_CLOEXEC (nothing this
 * process opens lacks it), or the PARENT holds the very same one (its inode), whatever its flag here. The second sign is
 * the robust one: CI measured the parent's listener arriving flagged close-on-exec in the host (02004002) — kept by the
 * first rule alone, and still holding the window's port. Each end of a socketpair (the IPC channel) has its own inode, and
 * what this process made itself (tsx's esbuild pipes, in tests) the parent does not hold.
 */
export function inheritedFds(fds: readonly number[], infoOf: (fd: number) => FdInfo | null, keep: ReadonlySet<number>, parentHolds: ReadonlySet<string>): number[] {
    return fds.filter((fd) => {
        if (fd < 3 || keep.has(fd)) return false;
        const info = infoOf(fd);
        if (!info) return false;
        if (!info.target.startsWith('socket:') && !info.target.startsWith('pipe:')) return false;
        return (info.flags & O_CLOEXEC) === 0 || parentHolds.has(info.target);
    });
}

/** What the parent holds open now (`socket:[N]`, `pipe:[N]`, paths): empty when it is gone or not readable. */
function parentTargets(): Set<string> {
    const out = new Set<string>();
    const ppid = process.ppid;
    if (!(ppid > 1)) return out;
    try {
        for (const fd of readdirSync(`/proc/${ppid}/fd`)) {
            try { out.add(readlinkSync(`/proc/${ppid}/fd/${fd}`)); } catch { /* gone */ }
        }
    } catch { /* not readable */ }
    return out;
}

function fdInfo(fd: number): FdInfo | null {
    try {
        const m = /^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'));
        if (!m) return null;
        return { flags: parseInt(m[1]!, 8), target: readlinkSync(`/proc/self/fd/${fd}`) };
    } catch {
        return null;
    }
}

/** Close every socket and pipe this process inherited (Linux). Answers what it closed, `fd (target)` each. */
export function closeInheritedFds(): string[] {
    if (process.platform !== 'linux') return [];
    let fds: number[];
    try {
        fds = readdirSync('/proc/self/fd').map(Number).filter((n) => Number.isInteger(n));
    } catch {
        return [];
    }
    const channel = Number(process.env.NODE_CHANNEL_FD);
    const keep = new Set(Number.isInteger(channel) ? [channel] : []);
    const closed: string[] = [];
    for (const fd of inheritedFds(fds, fdInfo, keep, parentTargets())) {
        const target = fdInfo(fd)?.target ?? '?';
        try { closeSync(fd); closed.push(`${fd} (${target})`); } catch { /* already gone */ }
    }
    return closed;
}
