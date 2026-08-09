import { planHostAllowlist } from './host-allowlist';
import type { DevSiteConfig } from './sites-config';

/**
 * The env a host-native site process runs with (story #238, task #672).
 *
 * A host-native site is the user's serve command run as a HOST process (not inside
 * the sandbox), so it reaches the workspace's Genie-managed services on their
 * PUBLISHED loopback ports — the same host-form env terminals + `manageProcess`
 * already get (beta.237, terminal/ipc.ts). The composition mirrors the sandbox
 * path's precedence exactly (site-manager.ts), so switching a site to host-native
 * changes only WHERE it runs, not which values win:
 *   1. GENIE_HOST_GATEWAY — weakest, user-overridable. On the host, `localhost`
 *      already IS the host, so it's plain loopback (in the sandbox it was the
 *      host-gateway address a container needs to escape its netns).
 *   2. the host-allowlist plan — Genie's guess at making a framework accept the
 *      `.gen` Host (Django ALLOWED_HOSTS, Vite allowedHosts, …).
 *   3. the site's OWN pinned env.
 *   4. the workspace SERVICE env (host-form) — injected LAST, and it WINS: it names
 *      the real engine on 127.0.0.1:<published port>.
 */

/** On the host, services bind loopback directly — no host-gateway hop. */
const HOST_LOOPBACK = '127.0.0.1';

export function composeHostSiteEnv(
    config: DevSiteConfig,
    command: string[],
    serviceHostEnv: Record<string, string>,
): Record<string, string> {
    return {
        GENIE_HOST_GATEWAY: HOST_LOOPBACK,
        ...planHostAllowlist({
            genName: config.genName,
            ...(config.framework ? { framework: config.framework } : {}),
            ...(config.stack ? { stack: config.stack } : {}),
            ...(config.server ? { server: config.server } : {}),
            command,
            ...(config.upstreamHost ? { upstreamHost: config.upstreamHost } : {}),
        }).env,
        ...(config.env ?? {}),
        ...serviceHostEnv,
    };
}

/** Everything a detached host site process is started with. */
export interface HostSiteSpawnSpec {
    /** The serve command argv (validated upstream). */
    command: string[];
    /** The repo dir on the host to run it in. */
    cwd: string;
    env: Record<string, string>;
    /** File the process's stdout/stderr are captured to. */
    logPath: string;
}

/** The platform primitives a host site's lifecycle needs, injected so the
 *  start/stop/alive orchestration is unit-tested and only the leaves (Node
 *  child_process / process.kill / taskkill) touch the OS. */
export interface HostSpawnPrimitives {
    platform: NodeJS.Platform;
    /** Spawn detached, returning the pid (a process-GROUP leader on posix). */
    spawnDetached: (spec: HostSiteSpawnSpec) => number;
    /** process.kill semantics: false when the target is gone (throws → dead). */
    signal: (pid: number, sig: NodeJS.Signals | 0) => boolean;
    /** Windows tree kill (no process groups there). */
    killTreeWin: (pid: number) => Promise<void>;
}

/** `taskkill` argv that ends a process AND its children, forcefully. */
export function killTreeWinArgv(pid: number): string[] {
    return ['taskkill', '/pid', String(pid), '/t', '/f'];
}

/** How to hand a host-native command to `child_process.spawn` on THIS platform. */
export interface HostSpawnInvocation {
    /** The spawn `file`: the bare binary on posix, the full command line on win32. */
    file: string;
    /** The spawn `args`: the rest on posix, EMPTY on win32 (folded into `file`). */
    args: string[];
    /** Whether to run through the shell (win32 only). */
    shell: boolean;
    /**
     * Detach into a new process GROUP — posix only. On Windows `detached:true`
     * allocates a NEW CONSOLE for the child, which pops as a stray terminal window
     * OUTSIDE Genie (and `windowsHide` does NOT suppress a detached console); Windows
     * has no process groups, so we never detach there and kill the tree with
     * `taskkill /t` instead.
     */
    detached: boolean;
}

/** Quote ONE argv token for a cmd.exe command line — only when it needs it, so a
 *  token with a space (a path, a flag value) survives as a single argument. */
function quoteWinToken(token: string): string {
    if (token === '') return '""';
    if (!/[\s"&|<>^()]/.test(token)) return token;
    return `"${token.replace(/"/g, '""')}"`;
}

/**
 * How a host-native dev server is launched on each platform (story #238; the moic
 * "no pid" report).
 *
 * On WINDOWS the dev-server entrypoints are almost all shims — `npm`/`pnpm`/`yarn`
 * are `.cmd`, and `php` is often a `.bat` (Herd, XAMPP) — and `child_process.spawn`
 * launches `.exe` only: without a shell it fails with ENOENT and returns no pid,
 * which is exactly the failure the reporter saw. So on win32 Genie runs the command
 * THROUGH the shell as a single, properly-quoted command line and lets cmd.exe do
 * the PATHEXT resolution the shim needs.
 *
 * On POSIX there are no such shims and native PATH resolution applies, so the
 * command runs DIRECTLY (no shell) — which keeps the dev server itself the
 * process-GROUP leader that {@link stopHostSite}'s `-pid` SIGTERM signals. A shell
 * there would make the SHELL the leader and the signal would miss the real server.
 */
export function hostSpawnInvocation(
    command: string[],
    platform: NodeJS.Platform,
): HostSpawnInvocation {
    if (platform === 'win32') {
        return { file: command.map(quoteWinToken).join(' '), args: [], shell: true, detached: false };
    }
    return { file: command[0], args: command.slice(1), shell: false, detached: true };
}

/**
 * The DIAGNOSABLE reason a host-native spawn failed. A host-native site runs the
 * repo's OWN dev server as a host process, so the overwhelmingly common failure is
 * the binary not being installed / on Genie's PATH — which `child_process` surfaces
 * only as an absent pid (the errno arrives later, on an async `error` event). Name
 * the binary and the host-toolchain requirement so the message is actionable on its
 * own, and fold in the errno when the async error handler recovers it.
 */
export function describeHostSpawnFailure(command: string[], detail?: string): string {
    const bin = command[0] ?? '';
    const base =
        `could not start "${bin}" — a host-native site runs the repo's own dev server ` +
        `on the host, so "${bin}" must be installed and on Genie's PATH`;
    return detail ? `${base} (${detail})` : base;
}

/** Start a host site's serve command detached; returns the tracked pid. */
export function startHostSite(spec: HostSiteSpawnSpec, prims: HostSpawnPrimitives): number {
    if (!Array.isArray(spec.command) || spec.command.length === 0) {
        throw new Error('host site has no command to run');
    }
    return prims.spawnDetached(spec);
}

/** Stop a host site: on posix signal the whole GROUP (the detached child is its
 *  leader, so its dev server + children die together); on Windows tree-kill. */
export async function stopHostSite(pid: number, prims: HostSpawnPrimitives): Promise<void> {
    if (prims.platform === 'win32') {
        await prims.killTreeWin(pid);
        return;
    }
    prims.signal(-pid, 'SIGTERM');
}

/** Whether a host site's process is still alive (signal 0 probe). */
export function hostSiteAlive(pid: number, prims: HostSpawnPrimitives): boolean {
    return prims.signal(pid, 0);
}
