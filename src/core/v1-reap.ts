import type { RunningProcess } from '../main/upgrade.js';

/**
 * REAPING GENIE 1's RUNTIME — pure.
 *
 * The owner's first real upgrade (2026-10-11): v1 quit, Genie 2 came up, and **73 of v1's processes
 * kept running** — 42 terminal shells, 6 caddy site servers, php, php-cgi, frankenphp, node dev
 * servers — orphaned, managed by nobody, holding ports. §7.2's teardown stops what runs from the
 * INSTALL directory; v1's runtime runs from `%APPDATA%\genie\{runtime,toolchain,pty-host}` and its
 * shells are Git's bash, so none of it was in scope. This is the rule Genie 2 applies at boot:
 *
 * - a process whose executable is under one of v1's runtime roots is a victim;
 * - an ORPHANED interactive shell (bash, cmd, powershell, pwsh, sh, zsh whose parent pid no longer
 *   exists) is a victim — a shell nobody is attached to is a dead pty host's child;
 * - every descendant of a victim is a victim;
 * - nothing in Genie 2's own ancestry is ever a victim, and a shell with a LIVE parent is left alone
 *   (the person's own terminal, an SSH session, Genie 2's own ptys).
 *
 * The caller kills each pid by itself and REPORTS what it did (`~/.genie/v1-reap.json`); a reap that
 * says nothing is the thing that produced 73 orphans in the first place.
 */

export interface ReapVictim {
    readonly pid: number;
    readonly executable: string;
    readonly why: 'v1 runtime binary' | 'orphaned shell' | 'child of a victim';
}

export const DEFAULT_SHELLS: readonly string[] = ['bash.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'sh.exe', 'zsh.exe', 'bash', 'sh', 'zsh'];

export interface ReapOptions {
    /** v1's runtime roots — `<userData>/runtime`, `<userData>/toolchain`, `<userData>/pty-host`. */
    readonly roots: readonly string[];
    /** Genie 2's own pid: it and its ancestors are never victims. */
    readonly selfPid: number;
    readonly shells?: readonly string[];
    /**
     * Whether orphaned INTERACTIVE shells may be taken at all: only on the boot that imports Genie 1, when its pty host
     * has just died. Absent / false = every other boot, where only v1's runtime binaries (provable by path) are taken —
     * an orphaned shell then is somebody's background work, not Genie 1's (the owner's desktop, 2026-10-13).
     */
    readonly includeShells?: boolean;
}

/** The arguments of a command line after its executable, split on whitespace outside double quotes. */
function argsOf(commandLine: string): string[] {
    const tokens = commandLine.match(/"[^"]*"|\S+/g) ?? [];
    return tokens.slice(1).map((t) => t.replace(/^"|"$/g, ''));
}

const POSIX_INTERACTIVE = new Set(['-l', '--login', '-i', '-il', '-li', '--noprofile', '--norc', '-']);
const PS_INTERACTIVE = new Set(['-nologo', '-noprofile', '-noexit', '-sta', '-mta', '-interactive']);

/**
 * An INTERACTIVE shell: one that runs nothing but itself — what a pty host opens for a person. `bash x.sh`, `bash -c`,
 * `cmd /c`, `cmd /k <cmd>`, `powershell -File` / `-Command` run something and are somebody's work. An unreadable
 * command line is NOT interactive: unknown is never taken for Genie 1's.
 */
export function isInteractiveShell(executable: string, commandLine: string | null | undefined): boolean {
    if (commandLine === null || commandLine === undefined) return false;
    const name = basename(executable).replace(/\.exe$/, '');
    const args = argsOf(commandLine);
    if (name === 'cmd') return args.every((a) => a.startsWith('/') && !/^\/[ck]$/i.test(a));
    if (name === 'powershell' || name === 'pwsh') return args.every((a) => PS_INTERACTIVE.has(a.toLowerCase()));
    return args.every((a) => POSIX_INTERACTIVE.has(a));
}

function norm(p: string): string {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:\//i.test(s) ? s.toLowerCase() : s;
}

function basename(p: string): string {
    const s = p.replace(/\\/g, '/');
    return s.slice(s.lastIndexOf('/') + 1).toLowerCase();
}

export function v1Leftovers(processes: readonly RunningProcess[], options: ReapOptions): ReapVictim[] {
    const byPid = new Map<number, RunningProcess>();
    for (const p of processes) byPid.set(p.pid, p);
    const roots = options.roots.map((r) => norm(r) + '/');
    const shells = new Set((options.shells ?? DEFAULT_SHELLS).map((s) => s.toLowerCase()));

    // Genie 2's own ancestry: never.
    const protectedPids = new Set<number>();
    for (let pid: number | null = options.selfPid; pid !== null && !protectedPids.has(pid); ) {
        protectedPids.add(pid);
        pid = byPid.get(pid)?.parentPid ?? null;
    }

    const victims = new Map<number, ReapVictim>();
    for (const p of processes) {
        if (protectedPids.has(p.pid)) continue;
        const exe = norm(p.executable);
        const fromV1 = roots.some((r) => exe.startsWith(r));
        const orphan = p.parentPid !== null && !byPid.has(p.parentPid);
        if (fromV1) victims.set(p.pid, { pid: p.pid, executable: p.executable, why: 'v1 runtime binary' });
        else if (options.includeShells === true && orphan && shells.has(basename(p.executable)) && isInteractiveShell(p.executable, p.commandLine)) victims.set(p.pid, { pid: p.pid, executable: p.executable, why: 'orphaned shell' });
    }

    // Descendants, to a fixed point.
    let grew = true;
    while (grew) {
        grew = false;
        for (const p of processes) {
            if (victims.has(p.pid) || protectedPids.has(p.pid) || p.parentPid === null) continue;
            if (victims.has(p.parentPid)) { victims.set(p.pid, { pid: p.pid, executable: p.executable, why: 'child of a victim' }); grew = true; }
        }
    }
    return [...victims.values()];
}
