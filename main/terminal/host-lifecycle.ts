import {
    readPidfile,
    pidfileUsable,
    deletePidfile,
} from './host-locate';
import { HostClient } from './host-client';
import { setActiveBackend, inProcessBackend } from './manager';
import type { SettingsProvider, HostSpawner } from './ports';
import type { SnapshotStore } from './sessions';
import type { HostStatus } from './backend';

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
 *   opt in via Settings → Terminal → "Keep terminals running after quit".
 *
 * RUNTIME-AGNOSTIC: this module imports neither `electron` nor `../db`. The
 * connect-or-spawn-or-fallback LOGIC is core; the Electron specifics are
 * injected:
 *   - HostSpawner       — resolveHostScript / spawnDetached / userDataDir
 *                         (was app.getPath + child_process.spawn with execPath +
 *                          ELECTRON_RUN_AS_NODE).
 *   - SettingsProvider  — the `detached_terminals` read (was getAllSettings).
 *   - SnapshotStore     — passed to HostClient for cold-create snapshot probe.
 *   - onHostStatus      — the fallback toast sink, emits `host-status` instead of
 *                         a direct BrowserWindow broadcast.
 * Genie's adapter (genie-adapter.ts) supplies all four via configureHostLifecycle.
 */

interface HostLifecycleDeps {
    spawner: HostSpawner;
    settings: SettingsProvider;
    snapshots: SnapshotStore;
    onHostStatus: (status: HostStatus) => void;
}

let deps: HostLifecycleDeps | null = null;

/**
 * Wire the host lifecycle's injected ports. Called once by the adapter at
 * app-ready, before initTerminalBackend. NEVER configured = in-process only
 * (detachedEnabled below returns false defensively).
 */
export function configureHostLifecycle(d: HostLifecycleDeps): void {
    deps = d;
}

let client: HostClient | null = null;
let usingHost = false;

/** Emit the fallback host-status (was a direct BrowserWindow broadcast). */
function status(message: string, level: 'info' | 'warn' = 'warn'): void {
    deps?.onHostStatus({ message, level });
}

function detachedEnabled(): boolean {
    try {
        return deps?.settings.get('detached_terminals') === 'on';
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
 */
export async function initTerminalBackend(): Promise<{
    host: boolean;
    reattachIds: string[];
}> {
    // Ensure the in-process backend is the active default before anything.
    setActiveBackend(inProcessBackend());

    if (!deps || !detachedEnabled()) {
        return { host: false, reattachIds: [] };
    }
    const { spawner, snapshots } = deps;

    const userData = spawner.userDataDir();
    try {
        const hostScript = spawner.resolveHostScript();

        // 1) Try an existing host.
        let pf = readPidfile(userData);
        if (!pidfileUsable(pf)) {
            // Stale / dead / version-mismatch → clear it and spawn fresh.
            deletePidfile(userData);
            if (!hostScript) {
                // Can't find the compiled host script (packaging risk). Stay
                // in-process with a clear toast.
                status(
                    'Detached terminals unavailable (host not found) — using in-process. Sessions won\'t survive a full quit.',
                );
                return { host: false, reattachIds: [] };
            }
            spawner.spawnDetached(hostScript, { GENIE_USERDATA: userData });
            const up = await awaitUsableHost(userData);
            if (!up) {
                status(
                    'Detached terminals unavailable (host didn\'t start) — using in-process. Sessions won\'t survive a full quit.',
                );
                return { host: false, reattachIds: [] };
            }
            pf = readPidfile(userData);
        }

        if (!pf) {
            status(
                'Detached terminals unavailable — using in-process. Sessions won\'t survive a full quit.',
            );
            return { host: false, reattachIds: [] };
        }

        // 2) Connect.
        client = await HostClient.connect(pf.socketPath, snapshots);
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
        status(
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
    status(
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
