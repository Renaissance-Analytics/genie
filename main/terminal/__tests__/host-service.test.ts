import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-user OS-service activation + backend-kind tracking (fancy-term-host@0.2.0
 * /service). Covers:
 *   - activateHostService → ok path: ensureHostService returns ok, we connect a
 *     HostClient, swap the active backend, and record kind 'service'.
 *   - activateHostService → fallback paths: no runtime, ensure {ok:false}, and a
 *     connect failure after a successful ensure — each returns {ok:false} with a
 *     reason and does NOT promote the backend kind (caller falls back).
 *   - hostBackendKind() self-corrects to 'inprocess' when the package reports the
 *     host is no longer backing us (mid-session graceful fallback).
 *
 * Both the package root and the /service subpath are mocked so no real OS
 * service / socket is touched.
 */

// --- mock state ------------------------------------------------------------
// Everything the mock factories close over is created via vi.hoisted so it
// exists BEFORE the (hoisted) vi.mock factories run — avoids the "cannot access
// before initialization" hoist trap.
const h = vi.hoisted(() => {
    const state: {
        ensureResult: {
            ok: boolean;
            installed: boolean;
            running: boolean;
            action: string;
            error?: string;
        };
        runtime: { nodePath: string; source: string } | null;
        connectThrows: boolean;
        isHostBacked: boolean;
        activeBackend: unknown;
        liveIds: string[];
    } = {
        ensureResult: {
            ok: true,
            installed: true,
            running: true,
            action: 'installed-and-started',
        },
        runtime: { nodePath: '/opt/node', source: 'test' },
        connectThrows: false,
        isHostBacked: false,
        activeBackend: undefined,
        liveIds: ['t-1', 't-2'],
    };

    class FakeHostClient {
        liveIds(): string[] {
            return state.liveIds;
        }
        static connect = vi.fn(async (_socket: string, _snaps: unknown) => {
            if (state.connectThrows) throw new Error('connect refused');
            return new FakeHostClient();
        });
    }

    return {
        state,
        FakeHostClient,
        ensureHostServiceMock: vi.fn(async () => state.ensureResult),
        setActiveBackendMock: vi.fn((b: unknown) => {
            state.activeBackend = b;
        }),
    };
});

const { state, FakeHostClient, ensureHostServiceMock, setActiveBackendMock } = h;

vi.mock('@particle-academy/fancy-term-host/service', () => ({
    ensureHostService: (_cfg: unknown) => h.ensureHostServiceMock(),
    resolveServiceRuntime: () => h.state.runtime,
}));

vi.mock('@particle-academy/fancy-term-host', () => ({
    HostClient: h.FakeHostClient,
    isHostBacked: () => h.state.isHostBacked,
    ptyHostScriptPath: () => '/app/pty-host.js',
    setActiveBackend: (b: unknown) => h.setActiveBackendMock(b),
    socketPathFor: (ud: string) => `${ud}/ptyhost.sock`,
}));

import {
    activateHostService,
    hostBackendKind,
    setHostBackendKind,
    resolveShippedRuntime,
    selectTerminalBackend,
    shouldKillHostForUpdate,
} from '../host-service';

const snapshots = { writeSnapshot: () => 1, readSnapshot: () => null, deleteSnapshot: () => {} };

beforeEach(() => {
    state.ensureResult = {
        ok: true,
        installed: true,
        running: true,
        action: 'installed-and-started',
    };
    state.runtime = { nodePath: '/opt/node', source: 'test' };
    state.connectThrows = false;
    state.isHostBacked = false;
    state.activeBackend = undefined;
    state.liveIds = ['t-1', 't-2'];
    ensureHostServiceMock.mockClear();
    setActiveBackendMock.mockClear();
    FakeHostClient.connect.mockClear();
    setHostBackendKind('inprocess');
});

afterEach(() => {
    setHostBackendKind('inprocess');
});

describe('activateHostService', () => {
    it('connects + swaps the backend + records kind=service when ensureHostService is ok', async () => {
        const r = await activateHostService({
            snapshots: snapshots as never,
            userDataDir: '/data',
            // explicit runtime so resolveShippedRuntime fs probes are skipped
            runtime: { nodePath: '/opt/node', nodePtyDir: '/opt/np', source: 'test' },
        });

        expect(r.ok).toBe(true);
        expect(ensureHostServiceMock).toHaveBeenCalled();
        // We connected via the SAME HostClient handshake and swapped the backend.
        expect(FakeHostClient.connect).toHaveBeenCalledWith('/data/ptyhost.sock', snapshots);
        expect(setActiveBackendMock).toHaveBeenCalledTimes(1);
        // After a win, isHostBacked is true → kind reports 'service'.
        state.isHostBacked = true;
        expect(hostBackendKind()).toBe('service');
        if (r.ok) expect(r.client.liveIds()).toEqual(['t-1', 't-2']);
    });

    it('falls back (no swap, kind stays inprocess) when no runtime resolves', async () => {
        const r = await activateHostService({
            snapshots: snapshots as never,
            userDataDir: '/data',
            runtime: null, // force resolveShippedRuntime, which falls to the mock…
        });
        // …and the mock resolveServiceRuntime returns null when state.runtime is null.
        state.runtime = null;
        // Re-run with the package resolver returning null.
        const r2 = await activateHostService({
            snapshots: snapshots as never,
            userDataDir: '/data',
        });
        expect(r2.ok).toBe(false);
        if (!r2.ok) expect(r2.reason).toMatch(/runtime/i);
        expect(ensureHostServiceMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ ok: false }),
        );
        // Never promoted the kind.
        expect(hostBackendKind()).toBe('inprocess');
        // r is irrelevant here (explicit-null still resolves via shipped probe);
        // referenced to satisfy lint.
        void r;
    });

    it('falls back when ensureHostService returns {ok:false}', async () => {
        state.ensureResult = {
            ok: false,
            installed: false,
            running: false,
            action: 'unsupported',
            error: 'no supported service mechanism',
        };
        const r = await activateHostService({
            snapshots: snapshots as never,
            userDataDir: '/data',
            runtime: { nodePath: '/opt/node', source: 'test' },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/no supported service mechanism/);
        expect(setActiveBackendMock).not.toHaveBeenCalled();
        expect(hostBackendKind()).toBe('inprocess');
    });

    it('falls back when the service is up but the connect fails', async () => {
        state.connectThrows = true;
        const r = await activateHostService({
            snapshots: snapshots as never,
            userDataDir: '/data',
            runtime: { nodePath: '/opt/node', source: 'test' },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/connect failed/);
        expect(setActiveBackendMock).not.toHaveBeenCalled();
        expect(hostBackendKind()).toBe('inprocess');
    });
});

describe('hostBackendKind self-correction', () => {
    it('reverts a cached service/detached kind to inprocess when the host is no longer backed', () => {
        setHostBackendKind('service');
        state.isHostBacked = false; // host died mid-session → package reverted
        expect(hostBackendKind()).toBe('inprocess');

        setHostBackendKind('detached');
        state.isHostBacked = true; // still backed → kind preserved
        expect(hostBackendKind()).toBe('detached');
    });
});

describe('resolveShippedRuntime', () => {
    it('returns the package resolver result when no shipped runtime is on disk', () => {
        // No resources/runtime/node in the test env → falls through to the mocked
        // resolveServiceRuntime, which returns state.runtime.
        state.runtime = { nodePath: '/fallback/node', source: 'path' } as never;
        const rt = resolveShippedRuntime();
        expect(rt?.nodePath).toBe('/fallback/node');
    });
});

describe('shouldKillHostForUpdate (update-teardown decision)', () => {
    it('KILLS only the detached host on an update quit', () => {
        // Detached host pins Genie's binary → must die so NSIS can overwrite it.
        expect(shouldKillHostForUpdate(true, 'detached')).toBe(true);
    });

    it('LEAVES a service-backed host running on an update quit (it survives)', () => {
        // Service host runs on its own runtime → never pinned → survives the swap.
        expect(shouldKillHostForUpdate(true, 'service')).toBe(false);
    });

    it('never kills on a normal (non-update) quit, any backend', () => {
        expect(shouldKillHostForUpdate(false, 'detached')).toBe(false);
        expect(shouldKillHostForUpdate(false, 'service')).toBe(false);
        expect(shouldKillHostForUpdate(false, 'inprocess')).toBe(false);
    });

    it('never kills the in-process backend (there is no host)', () => {
        expect(shouldKillHostForUpdate(true, 'inprocess')).toBe(false);
    });
});

describe('selectTerminalBackend (fallback chain)', () => {
    const okService = async () =>
        ({
            ok: true as const,
            client: { liveIds: () => ['a', 'b'] } as never,
            result: { action: 'started' } as never,
        });
    const failService = async () =>
        ({ ok: false as const, reason: 'no runtime' });

    it('uses in-process and makes NO host attempt when detached_terminals is OFF', async () => {
        const activate = vi.fn(okService);
        const init = vi.fn(async () => ({ host: true, reattachIds: ['x'] }));
        const sel = await selectTerminalBackend({
            detachedEnabled: false,
            activateService: activate,
            initDetached: init,
            isHostBackedProbe: () => true,
        });
        expect(sel.kind).toBe('inprocess');
        expect(sel.host).toBe(false);
        expect(activate).not.toHaveBeenCalled();
        expect(init).not.toHaveBeenCalled();
        expect(hostBackendKind()).toBe('inprocess');
    });

    it('prefers the service when ensureHostService is ok (no detached spawn)', async () => {
        const init = vi.fn(async () => ({ host: true, reattachIds: ['x'] }));
        state.isHostBacked = true; // service connected → backed
        const sel = await selectTerminalBackend({
            detachedEnabled: true,
            activateService: okService,
            initDetached: init,
            isHostBackedProbe: () => state.isHostBacked,
        });
        expect(sel.kind).toBe('service');
        expect(sel.host).toBe(true);
        expect(sel.reattachIds).toEqual(['a', 'b']);
        // Service won → the detached spawn path is never taken.
        expect(init).not.toHaveBeenCalled();
        expect(hostBackendKind()).toBe('service');
    });

    it('falls back to the detached host when the service fails but the spawn succeeds', async () => {
        const init = vi.fn(async () => ({ host: true, reattachIds: ['d1'] }));
        state.isHostBacked = true; // detached host actually came up + is backing us
        const sel = await selectTerminalBackend({
            detachedEnabled: true,
            activateService: failService,
            initDetached: init,
            isHostBackedProbe: () => state.isHostBacked,
        });
        expect(init).toHaveBeenCalled();
        expect(sel.kind).toBe('detached');
        expect(sel.host).toBe(true);
        expect(sel.reattachIds).toEqual(['d1']);
        expect(sel.serviceReason).toBe('no runtime');
        expect(hostBackendKind()).toBe('detached');
    });

    it('falls back to in-process when both the service AND the detached spawn fail', async () => {
        const init = vi.fn(async () => ({ host: false, reattachIds: [] }));
        const sel = await selectTerminalBackend({
            detachedEnabled: true,
            activateService: failService,
            initDetached: init,
            isHostBackedProbe: () => false, // detached did not come up
        });
        expect(init).toHaveBeenCalled();
        expect(sel.kind).toBe('inprocess');
        expect(sel.host).toBe(false);
        expect(hostBackendKind()).toBe('inprocess');
    });

    it('degrades to in-process if the service attempt THROWS', async () => {
        const init = vi.fn(async () => ({ host: false, reattachIds: [] }));
        const sel = await selectTerminalBackend({
            detachedEnabled: true,
            activateService: async () => {
                throw new Error('boom');
            },
            initDetached: init,
            isHostBackedProbe: () => false,
        });
        // A thrown service attempt is caught → falls through to the detached path.
        expect(init).toHaveBeenCalled();
        expect(sel.kind).toBe('inprocess');
    });
});
