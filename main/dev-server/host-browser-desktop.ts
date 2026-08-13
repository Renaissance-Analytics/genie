import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildHostReconcileEffects, type HostEffectIo, type HostEffectPaths } from './host-effects';
import { reconcileHostSites, type HostReconcileResult, type HostSiteRoute } from './host-reconcile';
import { createHostBrowserReconciler, type HostBrowserReconciler } from './host-browser-reconcile';

/**
 * Bind the external-browser host reconcile to the real machine (story #238 P3).
 * The PATH resolution here is unit-tested; the fs/child_process leaves are thin
 * and validated by CI/real-machine, the same split the reconcile brain uses.
 */

export interface HostBrowserPathOpts {
    /** Genie's per-user data dir (`app.getPath('userData')`). */
    userDataDir: string;
    /** The packaged resources dir (`process.resourcesPath`), where the bundled
     *  caddy lives under `runtime/` (see build-service-runtime.mjs). */
    resourcesPath: string;
    platform: NodeJS.Platform;
    /** Windows only: `%SystemRoot%` (default `process.env.SystemRoot`). */
    systemRoot?: string;
}

/** The on-disk locations the reconcile reads/writes. The CA, leaf and Caddyfile
 *  live in the Genie data dir (unprivileged); only the OS hosts file and the trust
 *  store are system-owned, and those go through the elevated effects. */
export function hostBrowserPaths(opts: HostBrowserPathOpts): HostEffectPaths {
    const dir = path.join(opts.userDataDir, 'host-gen');
    const isWin = opts.platform === 'win32';
    const caddyBin = path.join(opts.resourcesPath, 'runtime', isWin ? 'caddy.exe' : 'caddy');
    const hostsFilePath = isWin
        ? path.join(opts.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
        : '/etc/hosts';
    return {
        caCertPath: path.join(dir, 'gen-ca.crt'),
        caKeyPath: path.join(dir, 'gen-ca.key'),
        leafCertPath: path.join(dir, 'gen-leaf.crt'),
        leafKeyPath: path.join(dir, 'gen-leaf.key'),
        caddyfilePath: path.join(dir, 'Caddyfile'),
        hostsFilePath,
        caddyBin,
    };
}

/**
 * How the host Caddy is spawned, per platform (genie#183).
 *
 * On Windows `detached: true` hands the child its OWN CONSOLE — a blank terminal
 * at `…\caddy.exe` that opens when a `.gen` site is first exposed and then just
 * sits there. It is not needed either: `caddy start` daemonises itself, so the
 * process we spawn exits immediately regardless. The same conclusion
 * `host-process-run.ts` reached for site dev servers, in the same words: on
 * win32 NEVER detach, always hide.
 *
 * On posix the detach is load-bearing (its own process group is what keeps the
 * daemon alive past this call), and `windowsHide` is simply inert.
 */
export function hostCaddySpawnOptions(platform: NodeJS.Platform | string): {
    detached: boolean;
    windowsHide: boolean;
} {
    return { detached: platform !== 'win32', windowsHide: true };
}

/** The real node bindings for {@link HostEffectIo}. Thin on purpose. */
export function hostBrowserIo(platform: NodeJS.Platform): HostEffectIo {
    const runToEnd = (cmd: string, args: string[]): Promise<{ code: number; stderr?: string }> =>
        new Promise((resolve) => {
            // `caddy reload` runs on EVERY reconcile (each browser-exposed site
            // start/stop), so without this a console flashes each time.
            const child = spawn(cmd, args, {
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true,
            });
            let stderr = '';
            child.stderr?.on('data', (d) => (stderr += String(d)));
            child.on('error', (e) => resolve({ code: 1, stderr: e.message }));
            child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
        });

    return {
        platform,
        readFile: async (p) => {
            try {
                return await readFile(p, 'utf8');
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw e;
            }
        },
        writeFile: async (p, content, o) => {
            await mkdir(path.dirname(p), { recursive: true });
            await writeFile(p, content, o?.mode === undefined ? {} : { mode: o.mode });
        },
        tempFile: async (content) => {
            // pid + hrtime keeps the name unique without a clock/random dependency.
            const p = path.join(tmpdir(), `genie-hosts-${process.pid}-${process.hrtime.bigint()}`);
            await writeFile(p, content);
            return p;
        },
        spawn: runToEnd,
        spawnDetached: (argv) =>
            new Promise((resolve) => {
                try {
                    const child = spawn(argv[0], argv.slice(1), {
                        stdio: 'ignore',
                        ...hostCaddySpawnOptions(platform),
                    });
                    child.on('error', (e) => resolve({ ok: false, error: e.message }));
                    child.unref();
                    // `caddy start` daemonises and exits; give it a tick to fail loudly.
                    setTimeout(() => resolve({ ok: true }), 50);
                } catch (e) {
                    resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
                }
            }),
    };
}

export interface DesktopHostBrowserOpts extends HostBrowserPathOpts {
    /** The live browser-exposed host-native routes (devServerHostBrowserRoutes). */
    routes: () => HostSiteRoute[];
    log?: (msg: string) => void;
    debounceMs?: number;
}

/** Assemble the desktop reconciler: live routes → real effects → reconcile. */
export function createDesktopHostBrowserReconciler(opts: DesktopHostBrowserOpts): HostBrowserReconciler {
    const paths = hostBrowserPaths(opts);
    const io = hostBrowserIo(opts.platform);
    const reconcile = (routes: HostSiteRoute[]): Promise<HostReconcileResult> =>
        reconcileHostSites(routes, buildHostReconcileEffects(paths, io));
    // A Genie CA on disk ⇒ this machine opted in before, so a boot with zero live
    // sites must still DRAIN a `.gen` hosts line left over from a previous session.
    const initiallyApplied = existsSync(paths.caCertPath);
    return createHostBrowserReconciler({
        routes: opts.routes,
        reconcile,
        initiallyApplied,
        ...(opts.log ? { log: opts.log } : {}),
        ...(opts.debounceMs === undefined ? {} : { debounceMs: opts.debounceMs }),
    });
}
