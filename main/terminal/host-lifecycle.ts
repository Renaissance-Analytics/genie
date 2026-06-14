import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import {
    readPidfile,
    pidfileUsable,
    deletePidfile,
    resolveHostScript,
} from './host-locate';
import { HostClient } from './host-client';
import { setActiveBackend, inProcessBackend } from './manager';
import { getAllSettings } from '../db';

/**
 * Tier 3 lifecycle: decide the backend at app-ready, manage the detached
 * pty-host, and handle graceful fallback.
 *
 * The flow (initTerminalBackend):
 *   1. If the `detached_terminals` setting is OFF (the default — see below) →
 *      use the in-process backend. Done. This is today's T1/T2 behaviour.
 *   2. ON → try to CONNECT to an existing host (pidfile alive + version match +
 *      socket reachable). Success → HostClient, reattach existing ptys.
 *   3. No usable host → SPAWN one detached, await its pidfile, then connect.
 *   4. Any failure (spawn, timeout, version mismatch, socket error) → fall back
 *      to the in-process backend and surface a NON-FATAL toast. The app stays
 *      fully functional.
 *
 * SETTING DEFAULT — `detached_terminals` defaults OFF.
 *   Rationale: T3 is the heaviest tier and its #1 risk is the dev-vs-packaged
 *   host-script path. Shipping it default-ON would put every user on an
 *   unproven detached process the first launch after upgrade. Default-OFF means
 *   the proven in-process T1/T2 path remains the out-of-box experience; users
 *   opt in via Settings → Terminal → "Keep terminals running after quit". The
 *   plan explicitly sanctions this ("Better to ship T3 behind a default-OFF
 *   setting than to ship a broken build").
 */

let client: HostClient | null = null;
let usingHost = false;

/** Pushed to every window so the renderer can toast the fallback. */
function toast(message: string, level: 'info' | 'warn' = 'warn'): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        try {
            w.webContents.send('terminal:host-status', { message, level });
        } catch {
            /* window tearing down */
        }
    }
}

function detachedEnabled(): boolean {
    try {
        const s = getAllSettings() as Record<string, string>;
        return s.detached_terminals === 'on';
    } catch {
        return false;
    }
}

/** True when the active backend is the detached host (diagnostics + before-quit). */
export function isHostBacked(): boolean {
    return usingHost && !!client && client.isConnected();
}

export function getHostClient(): HostClient | null {
    return client;
}

/**
 * Spawn the detached pty-host. ELECTRON_RUN_AS_NODE makes the Electron binary
 * (process.execPath) run as plain Node so node-pty's native ABI matches what the
 * app was built against. Detached + unref + stdio:'ignore' fully severs it from
 * the app's process tree so it outlives the quit.
 */
function spawnHost(hostScript: string): void {
    const child = spawn(process.execPath, [hostScript], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            GENIE_USERDATA: app.getPath('userData'),
        },
    });
    child.unref();
}

/** Poll for the pidfile to appear + become usable, up to `timeoutMs`. */
async function awaitUsableHost(userData: string, timeoutMs = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pf = readPidfile(userData);
        if (pidfileUsable(pf)) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
}

/**
 * Initialise the terminal backend at app-ready. Returns the list of host pty ids
 * that should be reattached by the renderer (empty for the in-process path or a
 * cold host). NEVER throws — every failure degrades to in-process.
 *
 * `onReady` (optional) lets the caller drive the reattach once the backend +
 * window are up.
 */
export async function initTerminalBackend(): Promise<{
    host: boolean;
    reattachIds: string[];
}> {
    // Ensure the in-process backend is the active default before anything.
    setActiveBackend(inProcessBackend());

    if (!detachedEnabled()) {
        return { host: false, reattachIds: [] };
    }

    const userData = app.getPath('userData');
    try {
        const hostScript = resolveHostScript(__dirname);

        // 1) Try an existing host.
        let pf = readPidfile(userData);
        if (!pidfileUsable(pf)) {
            // Stale / dead / version-mismatch → clear it and spawn fresh.
            deletePidfile(userData);
            if (!hostScript) {
                // Can't find the compiled host script (packaging risk). Stay
                // in-process with a clear toast.
                toast(
                    'Detached terminals unavailable (host not found) — using in-process. Sessions won\'t survive a full quit.',
                );
                return { host: false, reattachIds: [] };
            }
            spawnHost(hostScript);
            const up = await awaitUsableHost(userData);
            if (!up) {
                toast(
                    'Detached terminals unavailable (host didn\'t start) — using in-process. Sessions won\'t survive a full quit.',
                );
                return { host: false, reattachIds: [] };
            }
            pf = readPidfile(userData);
        }

        if (!pf) {
            toast(
                'Detached terminals unavailable — using in-process. Sessions won\'t survive a full quit.',
            );
            return { host: false, reattachIds: [] };
        }

        // 2) Connect.
        client = await HostClient.connect(pf.socketPath);
        client.on('error', onHostError);
        setActiveBackend(client);
        usingHost = true;
        return { host: true, reattachIds: client.liveIds() };
    } catch (err) {
        // 3) Any failure → fall back to in-process, app stays functional.
        // eslint-disable-next-line no-console
        console.error('[host-lifecycle] falling back to in-process:', err);
        try {
            client?.disconnect();
        } catch {
            /* ignore */
        }
        client = null;
        usingHost = false;
        setActiveBackend(inProcessBackend());
        toast(
            'Detached terminals unavailable — using in-process. Sessions won\'t survive a full quit.',
        );
        return { host: false, reattachIds: [] };
    }
}

/**
 * Host connection dropped mid-session (host crashed / was killed). Fall back to
 * the in-process backend so future create()s work, and toast. Existing windows'
 * ptys are gone, but the app keeps running; a remount spawns fresh in-process.
 */
function onHostError(err: Error): void {
    if (!usingHost) return;
    // eslint-disable-next-line no-console
    console.error('[host-lifecycle] host connection lost:', err.message);
    usingHost = false;
    client = null;
    setActiveBackend(inProcessBackend());
    toast(
        'Detached terminal host stopped — switched to in-process. Open terminals may need reopening.',
    );
}

/**
 * before-quit, host-backed: DO NOT kill the host ptys. Snapshot (T1) already ran
 * via the normal before-quit path; here we just disconnect the client and leave
 * the host running so the next launch reattaches.
 */
export function disconnectHostLeaveRunning(): void {
    if (client) {
        try {
            client.disconnect();
        } catch {
            /* ignore */
        }
    }
}
