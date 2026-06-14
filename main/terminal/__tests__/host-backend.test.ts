import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostStatus } from '../backend';
import type { SnapshotStore } from '../sessions';

/**
 * Tier 3 — backend selection + graceful fallback.
 *
 *   • Setting OFF (default)            → in-process backend, host:false.
 *   • Setting ON but host unavailable  → fall back to in-process, host:false,
 *                                        and a non-fatal host-status is emitted.
 *
 * Inversion: instead of mocking electron's app/BrowserWindow + ../../db, we drive
 * initTerminalBackend through configureHostLifecycle with TEST-DOUBLE PORTS:
 *   - a SettingsProvider map (detached_terminals on/off),
 *   - a HostSpawner whose resolveHostScript returns null (the cleanest
 *     "unavailable" case — it takes the spawn branch then hits the null-script
 *     guard → fallback, with no real process spawned),
 *   - a no-op SnapshotStore,
 *   - an onHostStatus sink we capture to assert the fallback toast.
 * No electron/db deep-mocking needed — host-lifecycle is now port-driven.
 */

// node-pty fake so the in-process backend can be constructed if touched.
vi.mock('node-pty', () => ({
    spawn: () => ({
        pid: 1,
        process: 'fake',
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
    }),
}));

import {
    initTerminalBackend,
    isHostBacked,
    configureHostLifecycle,
} from '../host-lifecycle';
import {
    terminalManager,
    inProcessBackend,
    configureInProcessBackend,
} from '../manager';
import type { HostSpawner, SettingsProvider } from '../ports';

let settings: Record<string, string> = {};
const statuses: HostStatus[] = [];

const noSnapshots: SnapshotStore = {
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
};

const settingsProvider: SettingsProvider = { get: (k) => settings[k] };

// HostSpawner whose script-resolve returns null → "host not found" branch.
const nullSpawner: HostSpawner = {
    resolveHostScript: () => null,
    userDataDir: () => '/tmp/genie-userdata',
    spawnDetached: () => {
        throw new Error('spawnDetached should not be called when script is null');
    },
};

configureInProcessBackend({ settings: settingsProvider, snapshots: noSnapshots });
configureHostLifecycle({
    spawner: nullSpawner,
    settings: settingsProvider,
    snapshots: noSnapshots,
    onHostStatus: (s) => statuses.push(s),
});

beforeEach(() => {
    settings = {};
    statuses.length = 0;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('backend selection', () => {
    it('setting OFF → in-process backend, host:false, no toast', async () => {
        settings = { detached_terminals: 'off' };
        const res = await initTerminalBackend();
        expect(res.host).toBe(false);
        expect(res.reattachIds).toEqual([]);
        expect(isHostBacked()).toBe(false);
        // Active backend is the in-process singleton.
        expect(terminalManager()).toBe(inProcessBackend());
        // No fallback toast when the user never opted in.
        expect(statuses.length).toBe(0);
    });

    it('setting ON but host unavailable → fallback to in-process + toast', async () => {
        settings = { detached_terminals: 'on' };
        const res = await initTerminalBackend();
        expect(res.host).toBe(false);
        expect(isHostBacked()).toBe(false);
        expect(terminalManager()).toBe(inProcessBackend());
        // A non-fatal fallback host-status was emitted.
        const toast = statuses[0];
        expect(toast).toBeTruthy();
        expect(toast.message).toMatch(/in-process/i);
    });
});
