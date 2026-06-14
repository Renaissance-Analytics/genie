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
    type SnapshotStore,
    type SettingsProvider,
    type Encryptor,
    type HostSpawner,
    type HostStatus,
} from '@particle-academy/fancy-term-host';

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
 *  getAllSettings — e.g. track_cwd defaults 'on', detached_terminals 'off'). */
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
