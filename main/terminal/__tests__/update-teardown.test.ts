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
} = {
    pidfile: null,
    alivePids: new Set<number>(),
    deletedPidfile: false,
    client: null,
};

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
    writeSpy.mockClear();
});

afterEach(() => {
    // Only restore the per-test process.kill spy — keep writeSpy alive across
    // tests (restoreAllMocks would detach it from the memoized store).
    killSpy?.mockRestore();
    killSpy = null;
});

describe('killHostForUpdate', () => {
    it('kills the host by its pidfile pid and waits until it is dead', async () => {
        hostState.pidfile = {
            pid: 4321,
            socketPath: 'pipe',
            protocolVersion: 1,
            startedAt: 0,
        };
        hostState.alivePids.add(4321);

        killSpy = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number) => {
                // Simulate the host exiting in response to the signal.
                hostState.alivePids.delete(pid);
                return true;
            });

        const res = await killHostForUpdate(3000);

        expect(killSpy).toHaveBeenCalledWith(4321);
        expect(res.killed).toBe(true);
        expect(res.alreadyDead).toBe(false);
        expect(hostState.deletedPidfile).toBe(true);
        expect(hostState.alivePids.has(4321)).toBe(false);
    });

    it('polls and waits when the host lingers, then succeeds once it dies', async () => {
        hostState.pidfile = {
            pid: 99,
            socketPath: 'pipe',
            protocolVersion: 1,
            startedAt: 0,
        };
        hostState.alivePids.add(99);
        killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true); // signal sent, host lingers

        // Host dies ~120ms later (after a couple of poll iterations).
        setTimeout(() => hostState.alivePids.delete(99), 120);

        const res = await killHostForUpdate(3000);
        expect(res.killed).toBe(true);
    });

    it('reports alreadyDead and skips process.kill when no live host', async () => {
        hostState.pidfile = null; // nothing running
        killSpy = vi.spyOn(process, 'kill');

        const res = await killHostForUpdate(3000);

        expect(killSpy).not.toHaveBeenCalled();
        expect(res.alreadyDead).toBe(true);
        expect(res.killed).toBe(false);
        // A stale/missing pidfile is cleaned up.
        expect(hostState.deletedPidfile).toBe(true);
    });

    it('returns killed=false if the host is still alive after the bounded wait', async () => {
        hostState.pidfile = {
            pid: 7,
            socketPath: 'pipe',
            protocolVersion: 1,
            startedAt: 0,
        };
        hostState.alivePids.add(7);
        killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true); // never dies

        const res = await killHostForUpdate(120); // short bound so the test is fast
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
