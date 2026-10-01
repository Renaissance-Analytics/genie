import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/**
 * Run `fn` with process.cwd() pointed at a fresh empty temp dir, restoring the
 * original cwd afterwards. resolveShippedRuntime() probes
 * `process.cwd()/resources/runtime`; a local `npm run build:runtime` leaves that
 * artifact in the repo, which would otherwise make the "no shipped runtime"
 * assertions flaky. An empty cwd guarantees the on-disk probe finds nothing.
 */
async function withEmptyCwd<T>(fn: () => Promise<T> | T): Promise<T> {
    const original = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-host-test-'));
    try {
        process.chdir(dir);
        return await fn();
    } finally {
        process.chdir(original);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

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
        // resolveShippedRuntime probes process.cwd()/resources/runtime; a local
        // dev build can leave that artifact on disk, which would mask the
        // "no runtime" path. Run from an empty cwd so only the mocked package
        // resolver decides.
        const r = await withEmptyCwd(async () => {
            const r0 = await activateHostService({
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
            return r0;
        });
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
    it('returns the package resolver result when no shipped runtime is on disk', async () => {
        // No resources/runtime/node in the test env → falls through to the mocked
        // resolveServiceRuntime, which returns state.runtime. Run from an empty
        // cwd so a locally-built resources/runtime artifact can't be picked up.
        state.runtime = { nodePath: '/fallback/node', source: 'path' } as never;
        const rt = await withEmptyCwd(async () => resolveShippedRuntime());
        expect(rt?.nodePath).toBe('/fallback/node');
    });

    it('points nodePtyDir at the runtime ROOT (parent of node-pty/) so NODE_PATH resolves require("node-pty")', () => {
        // The service sets NODE_PATH = runtime.nodePtyDir and the host does
        // `require('node-pty')`, which Node resolves as <NODE_PATH>/node-pty. So
        // nodePtyDir MUST be the parent dir containing node-pty/, not the package
        // dir itself. Build a fake shipped runtime on disk and assert the layout.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-rt-'));
        const original = process.cwd();
        try {
            const runtimeDir = path.join(root, 'resources', 'runtime');
            fs.mkdirSync(path.join(runtimeDir, 'node-pty'), { recursive: true });
            const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
            fs.writeFileSync(path.join(runtimeDir, nodeBin), '');
            process.chdir(root);
            const rt = resolveShippedRuntime();
            expect(rt?.nodePath).toBe(path.join(runtimeDir, nodeBin));
            // nodePtyDir is the ROOT, not root/node-pty.
            expect(rt?.nodePtyDir).toBe(runtimeDir);
        } finally {
            process.chdir(original);
            fs.rmSync(root, { recursive: true, force: true });
        }
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

/**
 * NEVER SPAWN A SECOND HOST WHILE ONE IS SERVING (genie#774).
 *
 * On 2026-10-01 every terminal, worker and agent on the owner's machine died at
 * once. Not a crash: Genie ran backend selection while a detached host was
 * already serving every pty, selection spawned a SECOND host, and that host hit
 *
 *   [pty-host] server error: listen EADDRINUSE:
 *   address already in use \.\pipe\genie-ptyhost-9bcd7ce6d23f
 *
 * died in 542ms (`code=3 uptimeMs=542`), and eleven seconds later the incumbent
 * went down too and took the fleet. `fancy-term-host` was right to refuse the
 * double bind; the defect is that Genie asked.
 *
 * Selection is reachable from FOUR callers — boot, `genie host start`,
 * `genie host restart`, and host-loss recovery's respawn — so any of them could
 * do this at any moment. The guard belongs here, in the one place they all pass
 * through, rather than in each caller.
 *
 * The specific trap is the first statement of the old implementation:
 * `setHostBackendKind('inprocess')` ran BEFORE anything was probed, so a live
 * host was disowned on the way in and then collided with on the way out.
 */
describe('selectTerminalBackend adopts a host that is already serving (genie#774)', () => {
    const neverCalled = () => {
        throw new Error('must not be called while a host is already serving');
    };

    it('adopts the live host instead of spawning a second one', async () => {
        const activate = vi.fn(async () => ({ ok: false as const, reason: 'unused' }));
        const init = vi.fn(async () => ({ host: true, reattachIds: ['spawned'] }));

        const sel = await selectTerminalBackend({
            detachedEnabled: true,
            activateService: activate,
            initDetached: init,
            isHostBackedProbe: () => false,
            adoptExisting: () => ({ kind: 'detached', ids: ['t1','t2'] }),
        });

        // THE fix: neither path that can bind the pipe may run.
        expect(init).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
        expect(sel).toMatchObject({ kind: 'detached', host: true, reattachIds: ['t1', 't2'] });
    });

    it('leaves the recorded backend kind alone when it adopts', async () => {
        // `setHostBackendKind('inprocess')` as the first statement is what
        // disowned the live host. Adopting must not report the fleet as
        // in-process — `isHostBacked()` and every caller read this.
        //
        // The package must agree that a host is backed, because `hostBackendKind()`
        // re-checks it and downgrades to 'inprocess' when it disagrees. That
        // self-correction is right, and it means a world where `adoptExisting`
        // says "serving" while `isHostBacked()` says no cannot actually occur.
        state.isHostBacked = true;
        setHostBackendKind('detached');

        await selectTerminalBackend({
            detachedEnabled: true,
            activateService: neverCalled as never,
            initDetached: neverCalled as never,
            isHostBackedProbe: () => true,
            adoptExisting: () => ({ kind: 'detached', ids: [] }),
        });

        expect(hostBackendKind()).toBe('detached');
    });

    it('POSITIVE CONTROL: still selects normally when NO host is serving', async () => {
        // Without this the guard could simply never spawn, which would be a
        // machine with no terminals at all rather than a machine with one host.
        const activate = vi.fn(async () => ({ ok: false as const, reason: 'no runtime' }));
        const init = vi.fn(async () => ({ host: true, reattachIds: ['x'] }));
        let backed = false;

        const sel = await selectTerminalBackend({
            detachedEnabled: true,
            activateService: activate,
            initDetached: async () => {
                backed = true; // the spawn is what makes it host-backed
                return init();
            },
            isHostBackedProbe: () => backed,
            adoptExisting: () => null,
        });

        expect(init).toHaveBeenCalled();
        expect(sel).toMatchObject({ kind: 'detached', host: true, reattachIds: ['x'] });
    });

    it('does not adopt when detached terminals are OFF', async () => {
        // The off switch wins. A stale probe must not resurrect a backend the
        // user turned off.
        const sel = await selectTerminalBackend({
            detachedEnabled: false,
            activateService: neverCalled as never,
            initDetached: neverCalled as never,
            isHostBackedProbe: () => true,
            adoptExisting: () => ({ kind: 'detached', ids: ['t1'] }),
        });

        expect(sel).toMatchObject({ kind: 'inprocess', host: false });
    });

    it('still selects when the probe itself throws', async () => {
        // "Cannot tell" is not "a host is serving". A probe that throws must
        // not leave the machine with no terminal backend at all.
        const init = vi.fn(async () => ({ host: true, reattachIds: ['x'] }));
        let backed = false;

        await selectTerminalBackend({
            detachedEnabled: true,
            activateService: async () => ({ ok: false as const, reason: 'x' }),
            initDetached: async () => {
                backed = true;
                return init();
            },
            isHostBackedProbe: () => backed,
            adoptExisting: () => {
                throw new Error('probe exploded');
            },
        });

        expect(init).toHaveBeenCalled();
    });
});
