import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    buildServiceDescriptor,
    ensureHostService,
    resolveServiceConfig,
    resolveServiceRuntime,
    type EnsureResult,
    type ServiceIo,
    type ServiceRuntime,
} from '@particle-academy/fancy-term-host/service';
import {
    HostClient,
    isHostBacked,
    ptyHostScriptPath,
    setActiveBackend,
    socketPathFor,
} from '@particle-academy/fancy-term-host';

/**
 * Per-user OS-service activation for the pty-host (fancy-term-host@0.2.0
 * `/service` subpath).
 *
 * WHY: the detached pty-host (`HostSpawner.spawnDetached`) is launched as
 * Genie's own `process.execPath` + ELECTRON_RUN_AS_NODE, so it PINS Genie's
 * executable open. That's fine for a normal quit (the host outlives it and
 * terminals reattach live), but on an auto-update the NSIS/Squirrel installer
 * must OVERWRITE that binary — and the surviving host blocks it, so the update
 * stalls. Killing the host to unblock the installer loses the live sessions.
 *
 * A per-user OS service runs the host on its OWN standalone Node runtime, which
 * is never Genie's binary → never pinned. So a service-backed host survives
 * BOTH a quit AND an update with terminals live. The wire protocol, pidfile,
 * socket, and `HostClient` are all UNCHANGED — only WHO launches the host moves
 * from "Genie spawns a child" to "the OS service manager runs it". So after the
 * service is up we connect with the exact same `HostClient.connect(socket)`.
 *
 * THE ABI CRUX: the service refuses Genie's Electron binary, so it runs on a
 * standalone Node — which means node-pty's NATIVE binding must be built for THAT
 * Node's ABI, not Electron's. We therefore ship (via CI → extraResources) a
 * standalone `node` runtime + an ABI-matched `node-pty` prebuild and point the
 * service at them (`runtime.nodePath` / `runtime.nodePtyDir`). If that runtime
 * isn't present (e.g. CI hasn't shipped it yet, or a dev build), runtime
 * resolution returns null, `ensureHostService` returns `{ ok:false }`, and the
 * caller FALLS BACK to the detached-spawn path → in-process. The app never
 * breaks; the service simply doesn't activate until the runtime is shipped.
 *
 * Everything here is graceful: `ensureHostService` never throws, and every
 * resolution step is guarded so a missing path can only ever DOWNGRADE us to the
 * fallback, never crash.
 */

/** Which backend ended up active — surfaced for the update-teardown branch, the
 *  `willRestartPtyHost` warning flag, diagnostics, and the host-status toast. */
export type HostBackendKind = 'service' | 'detached' | 'inprocess';

// Track the active backend kind. Defaults to in-process (the safe floor); the
// init flow promotes it to 'service' or 'detached' once one of those wins.
let backendKind: HostBackendKind = 'inprocess';

/** The active terminal backend kind. Used by the update teardown (only a
 *  'detached' host pins Genie's binary → must be killed on update) and by the
 *  `willRestartPtyHost` flag (true ONLY for 'detached').
 *
 *  SELF-CORRECTING: the package's graceful-fallback can revert the active
 *  backend to in-process mid-session if a host dies (setActiveBackend(null)).
 *  In that case our cached 'service'/'detached' would be stale, so we re-check
 *  the package's `isHostBacked()`: when no host is actually backing us anymore,
 *  we report (and cache) 'inprocess'. This keeps the update-teardown branch and
 *  the willRestartPtyHost warning honest after a mid-session host loss. */
export function hostBackendKind(): HostBackendKind {
    if (backendKind !== 'inprocess') {
        let backed = false;
        try {
            backed = isHostBacked();
        } catch {
            backed = false;
        }
        if (!backed) backendKind = 'inprocess';
    }
    return backendKind;
}

/** Set by the init flow as each backend wins/falls back. Exported for the
 *  unit tests + the init orchestrator; not for general use. */
export function setHostBackendKind(kind: HostBackendKind): void {
    backendKind = kind;
}

/**
 * The stable reverse-DNS-ish service label. One per app+user; encodes the OS
 * user (via the package's userHash on the socket side already, but the label
 * itself is per-app — the per-user isolation comes from the LaunchAgent/systemd
 * --user/`schtasks` being installed in the CURRENT user's domain).
 */
export const HOST_SERVICE_LABEL = 'ai.tynn.genie.ptyhost';

/**
 * Resolve the standalone Node runtime + ABI-matched node-pty we ship for the
 * service. Returns null when the shipped runtime isn't found, so the caller
 * falls back. NEVER throws.
 *
 * Resolution order (most-specific → least):
 *   1. A runtime shipped beside the app as extraResources:
 *        <resources>/runtime/node[.exe]   (the standalone Node)
 *        <resources>/runtime/node-pty     (node-pty prebuilt for its ABI)
 *      In a packaged build `process.resourcesPath` is `<app>/resources`; in dev
 *      we look under the repo's `resources/runtime`.
 *   2. The package's own `resolveServiceRuntime()` — honours `$FANCY_TERM_NODE`,
 *      a plain-Node `process.execPath`, or a `node` on `$PATH` (it REFUSES an
 *      Electron binary). node-pty must then resolve from the host script's own
 *      node_modules (true for the unpacked dev tree, not for a packed asar).
 *
 * The shipped runtime (1) is the PRODUCTION path; (2) is a best-effort dev/CI
 * convenience. When neither yields a usable node, we return null → fallback.
 */
export function resolveShippedRuntime(): ServiceRuntime | null {
    // 1) Shipped standalone runtime (extraResources). In a packaged app this is
    //    process.resourcesPath; in dev there is no resourcesPath sentinel, so we
    //    probe the repo's resources/runtime too.
    const candidateRoots: string[] = [];
    try {
        if (process.resourcesPath) {
            candidateRoots.push(path.join(process.resourcesPath, 'runtime'));
        }
    } catch {
        /* resourcesPath unavailable outside a packaged app */
    }
    try {
        candidateRoots.push(path.join(app.getAppPath(), 'resources', 'runtime'));
        candidateRoots.push(path.join(process.cwd(), 'resources', 'runtime'));
    } catch {
        /* app may not be ready in some unit contexts */
    }

    const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
    for (const root of candidateRoots) {
        try {
            const nodePath = path.join(root, nodeBin);
            if (!fs.existsSync(nodePath)) continue;
            // node-pty (ABI-matched) ships as a package directory at
            // `<root>/node-pty/`. The service sets `NODE_PATH = runtime.nodePtyDir`
            // and the host does `require('node-pty')`, which Node resolves as
            // `<NODE_PATH>/node-pty`. So `nodePtyDir` must be the PARENT that
            // CONTAINS `node-pty/` — i.e. `<root>` itself, NOT `<root>/node-pty`.
            // (Pointing NODE_PATH straight at the package dir makes the bare
            // `require('node-pty')` resolve to `<root>/node-pty/node-pty` and fail.)
            const nodePtyPkg = path.join(root, 'node-pty');
            const hasNodePty = fs.existsSync(nodePtyPkg);
            return {
                nodePath,
                ...(hasNodePty ? { nodePtyDir: root } : {}),
                source: `shipped:${root}`,
            };
        } catch {
            /* probe next root */
        }
    }

    // 2) Package default resolution (env override / plain-node / PATH). Refuses
    //    Electron, returns null when nothing safe is found.
    try {
        return resolveServiceRuntime();
    } catch {
        return null;
    }
}

/**
 * Try to bring up the per-user OS service and CONNECT a HostClient to it.
 *
 * Returns:
 *   - { ok: true, client } when the service is installed + running at the right
 *     revision AND we connected — `backendKind` is set to 'service' and the
 *     active backend is swapped to the connected client.
 *   - { ok: false, reason } on any failure (unsupported OS, no runtime, install
 *     error, connect/handshake failure) — `backendKind` is LEFT as-is so the
 *     caller falls back to the detached-spawn path. NEVER throws.
 *
 * The connect step mirrors the detached-host connect: same socket path (derived
 * from userData), same `HostClient.connect()` handshake + mirror seed. A failed
 * connect after a successful ensure is still a fallback (we don't tear the
 * service down — it may be transiently slow; the detached path or the next
 * launch can reuse it).
 */
/**
 * Append a line to the host-service diagnostics log (best-effort). The service
 * install/connect path used to fail SILENTLY (a lone console.log), so a fallback
 * to the detached host — the thing that makes every update restart terminals —
 * was invisible. This persists the outcome to `<userData>/logs/host-service.log`.
 */
export function logHostService(line: string): void {
    try {
        const dir = path.join(app.getPath('userData'), 'logs');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
            path.join(dir, 'host-service.log'),
            `[${new Date().toISOString()}] ${line}\n`,
        );
    } catch {
        /* logging is best-effort — never let it break activation */
    }
}

/**
 * A {@link ServiceIo} that runs commands WITHOUT a shell, and logs each one.
 *
 * The package's default `nodeServiceIo()` spawns with `shell: true` on win32.
 * That breaks the Windows scheduled-task install: the `/TR` value is
 * `cmd /c "<path>"` — it has spaces AND embedded quotes, and shell arg-joining
 * doesn't escape the inner quotes, so `schtasks /Create` receives a mangled
 * command line and fails. The service then never installs and Genie silently
 * falls back to the detached host (which pins its own binary, so every update
 * must kill + restart terminals). Spawning WITHOUT a shell lets Node quote the
 * args correctly. Cross-platform: launchctl/systemctl resolve fine without a
 * shell; on win32 we append `.exe` since there's no PATHEXT resolution without
 * one. Every command + exit code + stderr is logged for visibility.
 */
function genieServiceIo(): ServiceIo {
    const fsp = fs.promises;
    return {
        run(argv) {
            let cmd = argv[0];
            const args = argv.slice(1);
            if (process.platform === 'win32' && !path.extname(cmd)) {
                cmd = `${cmd}.exe`;
            }
            return new Promise((resolve) => {
                let stdout = '';
                let stderr = '';
                const child = spawn(cmd, args, { shell: false, windowsHide: true });
                child.stdout?.on('data', (d) => (stdout += d.toString()));
                child.stderr?.on('data', (d) => (stderr += d.toString()));
                child.on('error', (err) => {
                    logHostService(`run [${argv.join(' ')}] → spawn error: ${err.message}`);
                    resolve({ code: -1, stdout, stderr: stderr + String(err) });
                });
                child.on('close', (code) => {
                    logHostService(
                        `run [${argv.join(' ')}] → code ${code}${
                            stderr.trim() ? ` · stderr: ${stderr.trim()}` : ''
                        }`,
                    );
                    resolve({ code: code ?? -1, stdout, stderr });
                });
            });
        },
        async writeFile(p, contents, opts) {
            await fsp.mkdir(path.dirname(p), { recursive: true });
            await fsp.writeFile(p, contents, { mode: opts?.mode ?? 0o600 });
        },
        async readFile(p) {
            try {
                return await fsp.readFile(p, 'utf8');
            } catch {
                return null;
            }
        },
        async mkdirp(dir) {
            await fsp.mkdir(dir, { recursive: true });
        },
        async rm(p) {
            await fsp.rm(p, { force: true }).catch(() => {});
        },
        async exists(p) {
            try {
                await fsp.access(p);
                return true;
            } catch {
                return false;
            }
        },
    };
}

export async function activateHostService(
    deps: {
        snapshots: Parameters<typeof HostClient.connect>[1];
        userDataDir: string;
        runtime?: ServiceRuntime | null;
    },
): Promise<
    | { ok: true; client: HostClient; result: EnsureResult }
    | { ok: false; reason: string; result?: EnsureResult }
> {
    const runtime = deps.runtime ?? resolveShippedRuntime();
    if (!runtime) {
        return {
            ok: false,
            reason: 'no standalone Node runtime for the service (shipped runtime missing) — falling back to detached spawn',
        };
    }

    let hostScript: string | undefined;
    try {
        hostScript = ptyHostScriptPath() ?? undefined;
    } catch {
        hostScript = undefined;
    }

    // WORKAROUND (win32 stale-state): the package treats "installed" as "the
    // unit file exists", not "the OS task is actually registered". A pre-fix
    // run (when the old shell:true io mangled the schtasks /TR quoting) could
    // leave a stale `<label>.cmd` on disk — writeFile succeeded but /Create
    // failed. ensureHostService then sees installed + matching-revision and
    // only ever issues /Run, which fails forever ("cannot find the file
    // specified") because the task was never created. Reconcile: if the unit
    // file exists but the real task query fails, delete the stale unit (and
    // best-effort /Delete) so ensureHostService takes the full install path and
    // /Create finally runs under our shell-free io.
    try {
        const io = genieServiceIo();
        const desc = buildServiceDescriptor(
            resolveServiceConfig({
                label: HOST_SERVICE_LABEL,
                userDataDir: deps.userDataDir,
                runtime,
                ...(hostScript ? { hostScript } : {}),
            }),
        );
        if (desc.platform === 'windows-task' && fs.existsSync(desc.unitPath)) {
            const q = await io.run(desc.statusArgv);
            if (q.code !== 0) {
                logHostService(
                    `stale unit file with no registered task (query code ${q.code}) — clearing ${desc.unitPath} to force a clean /Create`,
                );
                for (const argv of desc.uninstallArgv) await io.run(argv);
                await fs.promises.rm(desc.unitPath, { force: true }).catch(() => {});
            }
        }
    } catch (e) {
        logHostService(
            `stale-task reconcile skipped: ${e instanceof Error ? e.message : String(e)}`,
        );
    }

    let result: EnsureResult;
    try {
        // Pass our shell-free, logging io (NOT the package default, whose
        // shell:true mangles the Windows schtasks /TR quoting).
        result = await ensureHostService(
            {
                label: HOST_SERVICE_LABEL,
                userDataDir: deps.userDataDir,
                runtime,
                ...(hostScript ? { hostScript } : {}),
            },
            genieServiceIo(),
        );
    } catch (e) {
        // Documented never to throw — defensive guard so a surprise can't escape.
        return {
            ok: false,
            reason: `ensureHostService threw: ${e instanceof Error ? e.message : String(e)}`,
        };
    }

    if (!result.ok) {
        const reason =
            result.error ?? `service not ready (action=${result.action})`;
        logHostService(`service NOT ready → falling back to detached: ${reason}`);
        return { ok: false, reason, result };
    }

    // Service is up. Connect with the SAME HostClient handshake the detached
    // path uses — the socket/pidfile/protocol are unchanged.
    const socketPath = socketPathFor(deps.userDataDir);
    let client: HostClient;
    try {
        client = await HostClient.connect(socketPath, deps.snapshots);
    } catch (e) {
        const reason = `service running but connect failed: ${e instanceof Error ? e.message : String(e)}`;
        logHostService(`${reason} → falling back to detached`);
        return { ok: false, reason, result };
    }

    setActiveBackend(client);
    backendKind = 'service';
    logHostService(`per-user OS service ACTIVE (action=${result.action})`);
    return { ok: true, client, result };
}

/**
 * Update-teardown decision: should the before-quit teardown KILL the host?
 *
 * ONLY when (a) the quit is for an auto-update AND (b) the active backend is the
 * 'detached' host — the one launched as Genie's execPath child, which PINS the
 * binary so NSIS can't overwrite it while it's alive. A 'service'-backed host
 * runs on its own standalone Node runtime (never pins the binary) and SURVIVES
 * the update, so we leave it running exactly like a normal quit. 'inprocess' has
 * no host. Pure → directly unit-testable.
 */
export function shouldKillHostForUpdate(
    forUpdate: boolean,
    kind: HostBackendKind,
): boolean {
    return forUpdate && kind === 'detached';
}

/** What the backend-selection orchestrator resolved to. */
export interface BackendSelection {
    kind: HostBackendKind;
    host: boolean;
    reattachIds: string[];
    /** Diagnostics — how the service attempt resolved (when one was made). */
    serviceReason?: string;
    serviceAction?: string;
}

/**
 * The full backend-selection fallback chain, as a single injectable orchestrator
 * so it's unit-testable without booting the whole app:
 *
 *   detached_terminals OFF                  → in-process (no host attempt)
 *   ON → service ok                         → 'service'
 *   ON → service {ok:false} → detached ok   → 'detached'
 *   ON → service {ok:false} → detached fails → 'inprocess'
 *
 * Each step is graceful: a thrown service attempt or a thrown initDetached both
 * degrade to the next link, and `setHostBackendKind` records the winner. The
 * detached path's `initDetached` is `initTerminalBackend` from the package (it
 * connects-or-spawns the detached host and never throws), and `isHostBackedProbe`
 * is the package's `isHostBacked` (true → a detached host actually came up).
 *
 * Returns the reattach contract background.ts hands the renderer.
 */
export async function selectTerminalBackend(deps: {
    detachedEnabled: boolean;
    activateService: () => Promise<
        | { ok: true; client: HostClient; result: EnsureResult }
        | { ok: false; reason: string; result?: EnsureResult }
    >;
    initDetached: () => Promise<{ host: boolean; reattachIds: string[] }>;
    isHostBackedProbe: () => boolean;
}): Promise<BackendSelection> {
    setHostBackendKind('inprocess');
    if (!deps.detachedEnabled) {
        return { kind: 'inprocess', host: false, reattachIds: [] };
    }

    // 1) Service first.
    let svc:
        | { ok: true; client: HostClient; result: EnsureResult }
        | { ok: false; reason: string; result?: EnsureResult };
    try {
        svc = await deps.activateService();
    } catch (e) {
        svc = {
            ok: false,
            reason: `activateService threw: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
    if (svc.ok) {
        // activateHostService already swapped the backend + set kind='service';
        // set it here too so this orchestrator is the single source of truth for
        // the winning kind regardless of who set it.
        setHostBackendKind('service');
        return {
            kind: 'service',
            host: true,
            reattachIds: svc.client.liveIds(),
            serviceAction: svc.result.action,
        };
    }

    // 2) Fall back to the detached-spawn → in-process path.
    let detached = { host: false, reattachIds: [] as string[] };
    try {
        detached = await deps.initDetached();
    } catch {
        /* initTerminalBackend is internally guarded; belt-and-braces */
    }
    let backed = false;
    try {
        backed = deps.isHostBackedProbe();
    } catch {
        backed = false;
    }
    const kind: HostBackendKind = backed ? 'detached' : 'inprocess';
    setHostBackendKind(kind);
    return {
        kind,
        host: detached.host,
        reattachIds: detached.reattachIds,
        serviceReason: svc.reason,
    };
}
