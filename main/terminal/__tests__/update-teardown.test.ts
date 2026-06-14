import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Update-path teardown (alpha.44 stopgap). On the AUTO-UPDATE path a host-backed
 * Genie must:
 *   1. snapshot windowless host terminals so the cold post-update launch replays
 *      their history (not a fresh shell), and
 *   2. KILL the detached pty-host by its pidfile pid + WAIT (bounded) for it to
 *      die, because the host pins Genie's binary and NSIS can't overwrite it
 *      while it's alive.
 * A NORMAL quit must do NEITHER (the host survives so terminals come back live).
 *
 * These tests mock the @particle-academy/fancy-term-host exports the adapter
 * uses (pidfile + host client) and electron's `app`, and assert the kill +
 * wait + snapshot behaviour directly against killHostForUpdate /
 * snapshotHostTerminalsForUpdate.
 */

// --- mock state the fancy-term-host shim reads/writes ----------------------
const hostState: {
    pidfile: { pid: number; socketPath: string; protocolVersion: number; startedAt: number } | null;
    alivePids: Set<number>;
    deletedPidfile: boolean;
    client: {
        list: () => Array<{ id: string; pid: number; shell: string }>;
        getScrollback: (id: string) => string | undefined;
    } | null;
    // What the mocked graceful shutdownHost() does when called. By default it
    // simulates a clean graceful stop: the host dies and removes its pidfile.
    // Tests override this to simulate a rejection or a no-op (host lingers) so
    // the defensive pidfile-kill fallback can be exercised.
    shutdownHostImpl: (timeoutMs?: number) => Promise<void>;
} = {
    pidfile: null,
    alivePids: new Set<number>(),
    deletedPidfile: false,
    client: null,
    shutdownHostImpl: async () => {
        // Default: graceful stop succeeds — host kills its ptys, cleans up its
        // pidfile/socket and exits. Mirror that by clearing every alive pid and
        // removing the pidfile, just like the real host's own cleanup.
        hostState.alivePids.clear();
        hostState.pidfile = null;
        hostState.deletedPidfile = true;
    },
};

// Spy so tests can assert shutdownHost() was awaited (and with what timeout).
const shutdownHostMock = vi.fn((timeoutMs?: number) =>
    hostState.shutdownHostImpl(timeoutMs),
);

vi.mock('@particle-academy/fancy-term-host', () => ({
    // adapter wiring touched at import time — inert stubs
    ptyHostScriptPath: () => null,
    createSnapshotStore: () => ({
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    }),
    inProcessBackend: () => ({ on: () => {} }),
    configureInProcessBackend: () => {},
    terminalManager: () => ({}),
    configureHostLifecycle: () => {},
    // update-path surface under test
    getHostClient: () => hostState.client,
    readPidfile: () => hostState.pidfile,
    isPidAlive: (pid: number) => hostState.alivePids.has(pid),
    deletePidfile: () => {
        hostState.deletedPidfile = true;
        hostState.pidfile = null;
    },
    // 0.1.2 graceful shutdown — primary path under test.
    shutdownHost: (timeoutMs?: number) => shutdownHostMock(timeoutMs),
}));

vi.mock('../../db', () => ({
    getAllSettings: () => ({}),
    updateTerminalSpec: () => null,
}));

import {
    killHostForUpdate,
    snapshotHostTerminalsForUpdate,
    getSnapshotStore,
} from '../genie-adapter';

// Spy on the real snapshot store so we can see what gets written. The store is
// memoized by getSnapshotStore(), so this is the exact instance the helper uses.
const writeSpy = vi.spyOn(getSnapshotStore(), 'writeSnapshot');
// Loosely typed: vi.spyOn(process,'kill') yields an overloaded signature that
// doesn't unify with a single MockInstance generic.
let killSpy: { mockRestore: () => void } | null = null;

beforeEach(() => {
    hostState.pidfile = null;
    hostState.alivePids = new Set<number>();
    hostState.deletedPidfile = false;
    hostState.client = null;
    // Reset the graceful-shutdown mock to the default "clean stop" behaviour.
    hostState.shutdownHostImpl = async () => {
        hostState.alivePids.clear();
        hostState.pidfile = null;
        hostState.deletedPidfile = true;
    };
    shutdownHostMock.mockClear();
    writeSpy.mockClear();
});

afterEach(() => {
    // Only restore the per-test process.kill spy — keep writeSpy alive across
    // tests (restoreAllMocks would detach it from the memoized store).
    killSpy?.mockRestore();
    killSpy = null;
});

describe('killHostForUpdate', () => {
    it('awaits the graceful shutdownHost() and skips the pidfile kill when it works', async () => {
        hostState.pidfile = {
            pid: 4321,
            socketPath: 'pipe',
            protocolVersion: 1,
            startedAt: 0,
        };
        hostState.alivePids.add(4321);
        // Default shutdownHostImpl performs a clean graceful stop (host dies).
        killSpy = vi.spyOn(process, 'kill');

        const res = await killHostForUpdate(3000);

        // Graceful path is the PRIMARY: it was awaited with our timeout, and the
        // defensive pidfile process.kill never had to fire.
        expect(shutdownHostMock).toHaveBeenCalledWith(3000);
        expect(killSpy).not.toHaveBeenCalled();
        expect(res.killed).toBe(true);
        expect(res.alreadyDead).toBe(false);
        expect(hostState.alivePids.has(4321)).toBe(false);
    });

    it('falls back to the pidfile kill when shutdownHost() rejects', async () => {
        hostState.pidfile = {
            pid: 555,
            socketPath: 'pipe',
            protocolVersion: 1,
            startedAt: 0,
        };
        hostState.alivePids.add(555);
        // Graceful shutdown rejects (and leaves the host alive).
        hostState.shutdownHostImpl = async () => {
            throw new Error('shutdown wire send failed');
        };
        killSpy = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number) => {
                hostState.alivePids.delete(pid); // fallback SIGTERM lands
                return true;
            });

        const res = await killHostForUpdate(3000);

        expect(shutdownHostMock).toHaveBeenCalledWith(3000);
        // Defensive fallback fired: terminate by pidfile pid.
        expect(killSpy).toHaveBeenCalledWith(555);
        expect(res.killed).toBe(true);
        expect(hostState.deletedPidfile).toBe(true);
    });

    it('falls back to the pidfile kill when the host lingers after shutdownHost() resolves', async () => {
        hostState.pidfile = {
            pid: 99,
            socketPath: 'pipe',
            protocolVersion: 1,
            startedAt: 0,
        };
        hostState.alivePids.add(99);
        // Graceful shutdown resolves but does NOT actually stop the host.
        hostState.shutdownHostImpl = async () => {
            /* no-op: host stays alive */
        };
        killSpy = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number) => {
                hostState.alivePids.delete(pid);
                return true;
            });

        const res = await killHostForUpdate(3000);

        expect(shutdownHostMock).toHaveBeenCalled();
        expect(killSpy).toHaveBeenCalledWith(99);
        expect(res.killed).toBe(true);
    });

    it('reports alreadyDead and never calls shutdownHost/process.kill when no live host', async () => {
        hostState.pidfile = null; // nothing running
        killSpy = vi.spyOn(process, 'kill');

        const res = await killHostForUpdate(3000);

        // No host at all → bail before either teardown mechanism.
        expect(shutdownHostMock).not.toHaveBeenCalled();
        expect(killSpy).not.toHaveBeenCalled();
        expect(res.alreadyDead).toBe(true);
        expect(res.killed).toBe(false);
        // A stale/missing pidfile is cleaned up.
        expect(hostState.deletedPidfile).toBe(true);
    });

    it('returns killed=false if the host survives both graceful shutdown and the bounded fallback', async () => {
        hostState.pidfile = {
            pid: 7,
            socketPath: 'pipe',
            protocolVersion: 1,
            startedAt: 0,
        };
        hostState.alivePids.add(7);
        // Neither graceful shutdown nor the fallback SIGTERM ever kills it.
        hostState.shutdownHostImpl = async () => {
            /* no-op: host stays alive */
        };
        killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true); // never dies

        const res = await killHostForUpdate(120); // short bound so the test is fast
        expect(shutdownHostMock).toHaveBeenCalled();
        expect(killSpy).toHaveBeenCalledWith(7);
        expect(res.killed).toBe(false);
    });
});

describe('snapshotHostTerminalsForUpdate', () => {
    it('snapshots windowless host terminals and skips windowed ones', () => {
        hostState.client = {
            list: () => [
                { id: 'win', pid: 1, shell: 's' },
                { id: 'windowless', pid: 2, shell: 's' },
                { id: 'empty', pid: 3, shell: 's' },
            ],
            getScrollback: (id: string) =>
                id === 'empty' ? '' : `history-for-${id}`,
        };

        const hasWindow = (id: string) => id === 'win';
        const written = snapshotHostTerminalsForUpdate(hasWindow);

        // Only the windowless id with non-empty scrollback is written.
        expect(written).toBe(1);
        expect(writeSpy).toHaveBeenCalledWith('windowless', 'history-for-windowless');
        expect(writeSpy).not.toHaveBeenCalledWith('win', expect.anything());
        expect(writeSpy).not.toHaveBeenCalledWith('empty', expect.anything());
    });

    it('is a no-op when there is no host client', () => {
        hostState.client = null;
        const written = snapshotHostTerminalsForUpdate(() => false);
        expect(written).toBe(0);
        expect(writeSpy).not.toHaveBeenCalled();
    });
});
