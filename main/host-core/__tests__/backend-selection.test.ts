import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * genie #63 Phase 1 — `runBackendSelection` is the composition root's entry into
 * the backend ladder, shared by the desktop shell and the headless host-core.
 *
 * There is no longer a user setting feeding it: the Host is attempted on EVERY
 * launch. The only remaining bypass is `forceInProcess`, the E2E harness escape
 * hatch (the --no-pack test build ships no standalone runtime and a detached,
 * unref'd host would outlive the test run) — and taking it is LOGGED, because
 * running without a Host is a degraded mode, never a normal one.
 */

const h = vi.hoisted(() => ({
    selectTerminalBackend: vi.fn(async () => ({
        kind: 'service' as const,
        host: true,
        reattachIds: [] as string[],
    })),
    setHostBackendKind: vi.fn(),
    activateHostService: vi.fn(async () => ({ ok: false as const, reason: 'unused' })),
    logHostService: vi.fn(),
    initTerminalBackend: vi.fn(async () => ({ host: false, reattachIds: [] as string[] })),
}));

vi.mock('../../terminal/host-service', () => ({
    selectTerminalBackend: h.selectTerminalBackend,
    activateHostService: h.activateHostService,
    setHostBackendKind: h.setHostBackendKind,
    logHostService: h.logHostService,
}));

vi.mock('../../terminal/genie-adapter', () => ({
    getSnapshotStore: () => ({}),
}));

vi.mock('@particle-academy/fancy-term-host', () => ({
    initTerminalBackend: h.initTerminalBackend,
    isHostBacked: () => false,
}));

import { runBackendSelection } from '../backend-selection';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('runBackendSelection', () => {
    it('attempts the Host on a normal launch — no setting is consulted', async () => {
        const sel = await runBackendSelection({ userDataDir: '/ud' });
        expect(h.selectTerminalBackend).toHaveBeenCalledTimes(1);
        expect(sel.kind).toBe('service');
    });

    it('forceInProcess (E2E only) skips the Host entirely and logs why', async () => {
        const sel = await runBackendSelection({ userDataDir: '/ud', forceInProcess: true });
        expect(h.selectTerminalBackend).not.toHaveBeenCalled();
        expect(sel.kind).toBe('inprocess');
        expect(sel.host).toBe(false);
        expect(h.setHostBackendKind).toHaveBeenCalledWith('inprocess');
        expect(h.logHostService).toHaveBeenCalled();
        const logged = h.logHostService.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toMatch(/E2E/i);
    });
});
