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
