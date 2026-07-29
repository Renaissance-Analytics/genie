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
    resolveMaterializedHostScript,
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

/** SettingsProvider over the SQLite settings table (typed defaults applied by
 *  getAllSettings — e.g. track_cwd defaults 'on'). */
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

/**
 * The SettingsProvider handed to the package's HOST LIFECYCLE — the db provider
 * with the retired `detached_terminals` opt-in pinned ON.
 *
 * genie #63 Phase 1: the local Host is always running; there is no setting that
 * can turn it off, and Genie's own `detachedTerminalsEnabled()` gate is deleted.
 * But fancy-term-host carries its OWN copy of that gate inside
 * `initTerminalBackend()` — it reads `settings.get('detached_terminals') === 'on'`
 * through this provider and refuses to connect-or-spawn the host otherwise. An
 * install that persisted an explicit `'off'` before this release would therefore
 * still veto the always-on Host from inside the package, and the gate removal
 * would be half-wired.
 *
 * The composition root owns that seam, so it answers for the retired gate here.
 * The setting is no longer written by anything (the Settings row is gone) and
 * `getAllSettings()` no longer defaults it; this is the single place that still
 * has an opinion about it, and the opinion is "retired → on". The upstream fix is
 * for fancy-term-host to drop its gate (issue-first, per the Fancy contributing
 * protocol); until it does, this is the downstream mitigation.
 *
 * Every other key passes straight through untouched.
 */
export function hostLifecycleSettings(): SettingsProvider {
    const db = dbSettingsProvider();
    return {
        get: (key: string) => (key === 'detached_terminals' ? 'on' : db.get(key)),
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
            // Launch the pty-host from a USER-DATA copy (script + co-located
            // node-pty) so the host's `import 'node-pty'` resolves to the
            // user-data node-pty, not the install-dir one. The install-dir
            // node-pty's conpty.node/conpty.dll would otherwise be memory-mapped
            // by the running host and BLOCK the NSIS auto-update from overwriting
            // the install dir — forcing the installer to KILL the host, which is
            // why every update killed live terminals even though the standalone
            // teardown correctly LEFT the host running. Falls back to the in-place
            // script when the copy isn't available (dev, or a materialize failure).
            const script = resolveMaterializedHostScript() ?? scriptPath;

            // PREFER the shipped standalone Node runtime. Running the detached
            // host on its OWN node.exe (not Genie's Electron binary) means it does
            // NOT pin genie.exe — so an auto-update can overwrite Genie while the
            // host stays alive and terminals survive (the same property the OS
            // service has, but with no schtasks/launchd/systemd install — which is
            // exactly what's blocked on locked-down Windows). node-pty (N-API) now
            // resolves co-located to the user-data copy; NODE_PATH is kept as a
            // belt-and-suspenders (CJS-only; the ESM host ignores it). We record
            // the mode so the update-teardown + willRestartPtyHost know it won't pin.
            const rt = resolveShippedRuntime();
            if (rt?.nodePath) {
                const standaloneEnv: Record<string, string | undefined> = {
                    ...process.env,
                    ...(rt.nodePtyDir ? { NODE_PATH: rt.nodePtyDir } : {}),
                    ...env,
                };
                // Make sure no inherited Electron flag confuses standalone Node.
                delete standaloneEnv.ELECTRON_RUN_AS_NODE;
                const child = spawn(rt.nodePath, [script], {
                    detached: true,
                    // Hide the host's console window. node.exe is a console-
                    // subsystem app, so without this a `detached` spawn pops a
                    // visible console on Windows — and on Win11 (default terminal =
                    // Windows Terminal) that surfaces as a stray WT window on every
                    // host (re)spawn. The ptys themselves are windowless (ConPTY);
                    // this is only the HOST process's own console. Matches the
                    // package's service-spawn, which already sets windowsHide.
                    windowsHide: true,
                    stdio: 'ignore',
                    env: standaloneEnv,
                });
                child.unref();
                writeDetachedMode('standalone', child.pid, script);
                logHostService(
                    `detached host spawned on standalone Node — ${rt.nodePath}`,
                );
                return;
            }
            // Fallback: no standalone runtime shipped → run as Genie's execPath
            // child (pins the binary; the update will kill + restart it). Still
            // launches the materialized script so the host maps user-data node-pty
            // (the binary pin, not node-pty, is what forces the kill here).
            const child = spawn(process.execPath, [script], {
                detached: true,
                // Belt-and-suspenders: electron.exe is GUI-subsystem so it won't
                // create a console anyway, but keep the flag consistent with the
                // standalone-Node branch above.
                windowsHide: true,
                stdio: 'ignore',
                env: {
                    ...process.env,
                    ELECTRON_RUN_AS_NODE: '1',
                    ...env,
                },
            });
            child.unref();
            writeDetachedMode('electron', child.pid, script);
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

    // Host lifecycle: spawner + settings + snapshot store + host-status sink.
    // NOTE the provider — `hostLifecycleSettings()`, not the plain db one: the
    // package still consults the retired `detached_terminals` opt-in before it
    // will spawn the host, and genie #63 Phase 1 says nothing may gate the local
    // Host. See hostLifecycleSettings.
    configureHostLifecycle({
        spawner: electronHostSpawner(dirname),
        settings: hostLifecycleSettings(),
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
 * ONLY for the ELECTRON-mode fallback host — the one spawned as Genie's
 * `process.execPath` (+ ELECTRON_RUN_AS_NODE), which PINS Genie's executable so
 * NSIS can't overwrite it. The NORMAL detached host runs the user-data
 * standalone Node runtime (see materializeRuntimeToUserData) — it pins nothing
 * the updater touches and is LEFT RUNNING across the update (background.ts
 * gates this call on detachedHostPinsBinary()), so live terminals and their
 * agents survive the upgrade. On a NORMAL quit no host is ever killed
 * (disconnectHostLeaveRunning).
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
