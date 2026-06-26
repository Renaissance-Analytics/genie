import { app, BrowserWindow, safeStorage } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { getAllSettings, updateTerminalSpec } from '../db';
import {
    ptyHostScriptPath,
    createSnapshotStore,
    inProcessBackend,
    configureInProcessBackend,
    terminalManager,
    configureHostLifecycle,
    getHostClient,
    readPidfile,
    isPidAlive,
    deletePidfile,
    shutdownHost,
    type SnapshotStore,
    type SettingsProvider,
    type Encryptor,
    type HostSpawner,
    type HostStatus,
} from '@particle-academy/fancy-term-host';
import {
    resolveShippedRuntime,
    writeDetachedMode,
    logHostService,
} from './host-service';

/**
 * Genie adapter — the COMPOSITION ROOT for the terminal subsystem.
 *
 * This is the ONE place (alongside ipc.ts) that imports `electron` and `../db`.
 * It builds the Electron/SQLite implementations of the injected ports and wires
 * the runtime-agnostic core to them:
 *
 *   - Encryptor        over Electron `safeStorage` (preserving the
 *                      isEncryptionAvailable → plaintext-magic fallback).
 *   - SnapshotStore    rooted at `app.getPath('userData')/sessions`.
 *   - SettingsProvider = { get: k => getAllSettings()[k] }.
 *   - HostSpawner      = execPath + ELECTRON_RUN_AS_NODE detached spawn,
 *                        asar-aware resolveHostScript, userData dir.
 *
 * It also subscribes to the core's emitted events and persists/broadcasts them:
 *   - 'cwd'         → updateTerminalSpec({ live_cwd })   (was a direct db write in manager)
 *   - host-status   → BrowserWindow broadcast on `terminal:host-status`
 *                     (was a direct broadcast in host-lifecycle)
 *
 * The `'snapshot'` pointer write stays in ipc.ts (the snapshot capture is
 * inherently an IPC/quit-time flow); the SnapshotStore built here is shared with
 * both ipc.ts and the core backends.
 */

// --- Electron port implementations -----------------------------------------

/** Encryptor over Electron safeStorage. safeStorage's string API is wrapped to
 *  the Buffer-in/Buffer-out Encryptor contract: encrypt takes the (base64) gzip
 *  bytes as utf8 and returns the encrypted Buffer; decrypt reverses it. This
 *  preserves the exact bytes the old sessions.ts wrote via
 *  safeStorage.encryptString(gz.toString('base64')). */
export function electronEncryptor(): Encryptor {
    return {
        isAvailable: () => {
            try {
                return safeStorage.isEncryptionAvailable();
            } catch {
                return false;
            }
        },
        encrypt: (b: Buffer) => safeStorage.encryptString(b.toString('utf8')),
        decrypt: (b: Buffer) => Buffer.from(safeStorage.decryptString(b), 'utf8'),
    };
}

/** True when the user has opted into detached/persistent terminals (Settings →
 *  Terminal → "Keep terminals running after quit"). Mirrors the same setting the
 *  package's host lifecycle reads via the SettingsProvider, surfaced here so the
 *  composition root (background.ts) can decide whether to even ATTEMPT the
 *  per-user OS service / detached host before calling initTerminalBackend.
 *
 *  Defaults ON: getAllSettings() resolves an unset value to 'on', so an
 *  unconfigured install opts INTO the detached host (terminals + their agents
 *  survive a restart). An explicit 'on'/'true'/'1' also enables it; only an
 *  explicit 'off' — or a db error, which fails SAFE to in-process so a read
 *  failure can't force the heavy detached path on — returns false. */
export function detachedTerminalsEnabled(): boolean {
    try {
        const v = (getAllSettings() as Record<string, string | undefined>)[
            'detached_terminals'
        ];
        return v === 'on' || v === 'true' || v === '1';
    } catch {
        return false;
    }
}

/** SettingsProvider over the SQLite settings table (typed defaults applied by
 *  getAllSettings — e.g. track_cwd defaults 'on', detached_terminals 'on'). */
export function dbSettingsProvider(): SettingsProvider {
    return {
        get: (key: string) => {
            try {
                return (getAllSettings() as Record<string, string | undefined>)[key];
            } catch {
                return undefined;
            }
        },
    };
}

/** HostSpawner over Electron: execPath + ELECTRON_RUN_AS_NODE so the detached
 *  host runs as plain Node with the app's node-pty ABI, package-provided host
 *  script resolution, and the userData dir for pidfile/socket.
 *
 *  The detached pty-host is no longer built by Genie — it ships inside
 *  `@particle-academy/fancy-term-host`. `ptyHostScriptPath()` self-locates the
 *  package's `dist/pty-host.js` (asar-aware: it tries the `app.asar.unpacked`
 *  path first, then the in-asar path — see electron-builder.yml asarUnpack,
 *  which unpacks the whole package dist + node-pty so plain Node can require
 *  them off disk). We guard with an existence check so a mis-resolved path
 *  returns null and the host lifecycle degrades to in-process + a non-fatal
 *  toast rather than spawning a non-existent script. `dirname` is retained for
 *  signature stability with the previous adapter; the package self-locates. */
export function electronHostSpawner(_dirname: string): HostSpawner {
    return {
        resolveHostScript: () => {
            try {
                const p = ptyHostScriptPath();
                return p && fs.existsSync(p) ? p : null;
            } catch {
                return null;
            }
        },
        userDataDir: () => app.getPath('userData'),
        spawnDetached: (scriptPath: string, env: Record<string, string>) => {
            // PREFER the shipped standalone Node runtime. Running the detached
            // host on its OWN node.exe (not Genie's Electron binary) means it does
            // NOT pin genie.exe — so an auto-update can overwrite Genie while the
            // host stays alive and terminals survive (the same property the OS
            // service has, but with no schtasks/launchd/systemd install — which is
            // exactly what's blocked on locked-down Windows). The shipped node-pty
            // (N-API) loads via NODE_PATH=<runtime>. We record the mode so the
            // update-teardown + the willRestartPtyHost warning know it won't pin.
            const rt = resolveShippedRuntime();
            if (rt?.nodePath) {
                const standaloneEnv: Record<string, string | undefined> = {
                    ...process.env,
                    ...(rt.nodePtyDir ? { NODE_PATH: rt.nodePtyDir } : {}),
                    ...env,
                };
                // Make sure no inherited Electron flag confuses standalone Node.
                delete standaloneEnv.ELECTRON_RUN_AS_NODE;
                const child = spawn(rt.nodePath, [scriptPath], {
                    detached: true,
                    stdio: 'ignore',
                    env: standaloneEnv,
                });
                child.unref();
                writeDetachedMode('standalone');
                logHostService(
                    `detached host spawned on standalone Node — ${rt.nodePath}`,
                );
                return;
            }
            // Fallback: no standalone runtime shipped → run as Genie's execPath
            // child (pins the binary; the update will kill + restart it).
            const child = spawn(process.execPath, [scriptPath], {
                detached: true,
                stdio: 'ignore',
                env: {
                    ...process.env,
                    ELECTRON_RUN_AS_NODE: '1',
                    ...env,
                },
            });
            child.unref();
            writeDetachedMode('electron');
            logHostService(
                'detached host spawned on Genie binary (no standalone runtime shipped)',
            );
        },
    };
}

// --- Composition ------------------------------------------------------------

let snapshotStore: SnapshotStore | null = null;

/** The shared snapshot store rooted at userData/sessions, encrypted via
 *  safeStorage. Built once; reused by the core backends AND ipc.ts. */
export function getSnapshotStore(): SnapshotStore {
    if (!snapshotStore) {
        snapshotStore = createSnapshotStore({
            baseDir: app.getPath('userData'),
            encryptor: electronEncryptor(),
        });
    }
    return snapshotStore;
}

/** Broadcast a host-status toast to every window (was the BrowserWindow loop in
 *  host-lifecycle). Unchanged channel + payload shape. */
function broadcastHostStatus(s: HostStatus): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        try {
            w.webContents.send('terminal:host-status', s);
        } catch {
            /* window tearing down */
        }
    }
}

/**
 * Wire the terminal core to its Electron/SQLite adapters. Call ONCE at app-ready
 * BEFORE initTerminalBackend / registerTerminalIpc.
 *
 * `dirname` is main/background's __dirname (the compiled main bundle dir), used
 * to resolve the detached host script.
 */
export function wireTerminalAdapter(dirname: string): void {
    const settings = dbSettingsProvider();
    const snapshots = getSnapshotStore();

    // In-process backend: settings (cwd-hook gating) + snapshot store (cold-spawn
    // restore). MUST be configured before the singleton is first constructed.
    configureInProcessBackend({ settings, snapshots });

    // Subscribe to the core's emitted 'cwd' events → persist live_cwd. Was the
    // direct require('../db').updateTerminalSpec({ live_cwd }) inside manager.
    const backend = inProcessBackend();
    backend.on('cwd', (id: string, cwd: string) => {
        try {
            updateTerminalSpec(id, { live_cwd: cwd });
        } catch {
            /* db not ready / spec gone — cwd accuracy is best-effort */
        }
    });

    // Host lifecycle (T3): spawner + settings + snapshot store + host-status sink.
    configureHostLifecycle({
        spawner: electronHostSpawner(dirname),
        settings,
        snapshots,
        onHostStatus: broadcastHostStatus,
    });
}

/** Resolve the live active backend (in-process or host client). Re-exported so
 *  ipc.ts and quit helpers always hit the current backend after a T3 swap. */
export { terminalManager };

/**
 * Tear down the detached pty-host on the AUTO-UPDATE path so the NSIS installer
 * can overwrite Genie's binary.
 *
 * The detached pty-host runs as Genie's `process.execPath` (+ ELECTRON_RUN_AS_NODE)
 * so it PINS Genie's executable open. On a NORMAL quit that's the point — the host
 * survives so terminals come back live (background.ts uses
 * disconnectHostLeaveRunning). But on the AUTO-UPDATE path NSIS must OVERWRITE
 * that binary, and a surviving host blocks it.
 *
 * fancy-term-host@^0.1.2 exposes a GRACEFUL `shutdownHost()`: it sends a
 * `shutdown` wire message, the host runs its OWN cleanup (kills its ptys, removes
 * pidfile + socket, exits 0), and the package reverts to the in-process backend.
 * That replaces the alpha.44 interim SIGKILL-by-pidfile. We still keep that kill
 * as a DEFENSIVE fallback: if `shutdownHost()` rejects, or the host is somehow
 * still alive after it resolves, we fall back to terminating the host by its
 * pidfile pid + bounded poll — so a wedged host can never block the installer.
 *
 * Returns true if the host is confirmed dead (or was never running), false if it
 * was still alive after the bounded fallback. Best-effort + bounded so before-quit
 * can never hang on it.
 */
export async function killHostForUpdate(
    waitMs = 3000,
): Promise<{ killed: boolean; alreadyDead: boolean }> {
    const ud = app.getPath('userData');
    let pf: ReturnType<typeof readPidfile> = null;
    try {
        pf = readPidfile(ud);
    } catch {
        pf = null;
    }
    // No pidfile or a dead pid → nothing to kill. Clean up a stale pidfile.
    if (!pf || !isPidAlive(pf.pid)) {
        try {
            deletePidfile(ud);
        } catch {
            /* best-effort */
        }
        return { killed: false, alreadyDead: true };
    }

    // PRIMARY: ask the host to shut itself down gracefully (its own cleanup +
    // pidfile/socket removal + revert to in-process). Bounded by waitMs.
    // shutdownHost is documented never to throw, but we still guard it so a
    // rejection can't escape before the fallback runs.
    try {
        await shutdownHost(waitMs);
    } catch {
        /* fall through to the defensive pidfile kill below */
    }

    // If the graceful path got the host gone, we're done.
    if (!isPidAlive(pf.pid)) {
        try {
            deletePidfile(ud);
        } catch {
            /* best-effort — the host's own cleanup likely already removed it */
        }
        return { killed: true, alreadyDead: false };
    }

    // DEFENSIVE FALLBACK: graceful shutdown didn't take (rejected, timed out, or
    // host still alive). Terminate by pidfile pid and poll (bounded) for death.
    // SIGTERM (default) lets the host close its sockets; we don't escalate to
    // SIGKILL — the wait is short and the installer's own retry covers a laggard.
    try {
        process.kill(pf.pid);
    } catch {
        // Already gone between the probe and the kill, or no permission.
    }
    const deadline = Date.now() + Math.max(0, waitMs);
    let alive = isPidAlive(pf.pid);
    while (alive && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        alive = isPidAlive(pf.pid);
    }
    try {
        deletePidfile(ud);
    } catch {
        /* best-effort */
    }
    return { killed: !alive, alreadyDead: false };
}

/**
 * Update-path snapshot for HOST-backed terminals (T1 floor before the host is
 * killed). Mirrors snapshotRetainedWindowless, but for the DETACHED HOST: the
 * host owns the ptys and their scrollback, so on the update path — where we are
 * about to KILL the host — we must capture every host pty's history so the
 * post-update COLD launch replays it (AttachResult.snapshot) instead of coming
 * back fresh.
 *
 * Open windows already serialize via the before-quit terminal:snapshot-request →
 * SerializeAddon → terminal:snapshot flow (a cleaner reconstruction), so those
 * are skipped here to avoid clobbering them with raw bytes. Windowless host ptys
 * (e.g. a detached dev server with no open window) have no renderer to serialize
 * them — we pull the host's scrollback and write a raw-ANSI T1 snapshot; T1's
 * restore resets the screen (\x1bc) before the fresh shell, so raw
 * history-above-divider is the intended shape.
 *
 * `hasWindow(id)` lets ipc.ts inject its owner-registry knowledge without this
 * module importing the registry. Best-effort + synchronous-ish; never throws.
 */
export function snapshotHostTerminalsForUpdate(
    hasWindow: (id: string) => boolean,
): number {
    const client = getHostClient();
    if (!client) return 0;
    const store = getSnapshotStore();
    let written = 0;
    let ids: string[] = [];
    try {
        ids = client.list().map((t) => t.id);
    } catch {
        ids = [];
    }
    for (const id of ids) {
        // Covered by the renderer snapshot broadcast → skip (cleaner output).
        if (hasWindow(id)) continue;
        let scrollback: string | undefined;
        try {
            scrollback = client.getScrollback(id);
        } catch {
            scrollback = undefined;
        }
        if (!scrollback) continue;
        try {
            const bytes = store.writeSnapshot(id, scrollback);
            if (bytes == null) continue;
            written++;
            try {
                updateTerminalSpec(id, {
                    snapshot_at: Date.now(),
                    snapshot_bytes: bytes,
                });
            } catch {
                /* spec gone / db not ready — file is still written */
            }
        } catch {
            /* best-effort */
        }
    }
    return written;
}
