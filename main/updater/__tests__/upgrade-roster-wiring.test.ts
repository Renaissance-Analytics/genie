import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../../../test/electron-mock';

/**
 * WHAT `registerUpdaterIpc` HANGS ON THE PRE-APPLY SEAM (genie#551).
 *
 * `auto-updater.ts` owns the seam; this owns the policy. Two facts, and the
 * second is the one that is easy to get wrong:
 *
 *  - An apply that did NOT drain records the roster. That is the whole bug: on a
 *    machine whose pty host is expected to survive the swap, `restartPlanForUpgrade`
 *    always says `apply`, so this is the only chance the restore list gets.
 *  - An apply that FOLLOWS a completed drain must NOT re-record. The drain writes
 *    its roster before the first nudge, deliberately; by the time it clears, those
 *    agents have stopped, so re-recording would replace a correct list with an
 *    empty one — a silent regression that looks exactly like the bug being fixed.
 */

// Hoisted: `vi.mock` factories are lifted above every other statement, so the
// state they close over has to be lifted with them.
const { state, recordUpgradeRoster, ipcHandlers } = vi.hoisted(() => ({
    state: {
        drainCleared: false,
        beforeApply: null as (() => void) | null,
    },
    recordUpgradeRoster: vi.fn(),
    ipcHandlers: new Map<string, (...a: unknown[]) => unknown>(),
}));

vi.mock('electron', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../test/electron-mock')>();
    return {
        ...actual,
        ipcMain: {
            ...actual.ipcMain,
            handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
                ipcHandlers.set(channel, fn);
            },
        },
    };
});

vi.mock('../../agents/drain-service', () => ({
    beginUpgradeDrain: vi.fn(),
    cancelUpgradeDrain: vi.fn(),
    drainSnapshot: () => ({ active: false, startedAt: 0, rows: [], complete: false }),
    markUpgradeDrainCleared: vi.fn(),
    satisfyDrainRow: vi.fn(),
    upgradeDrainCleared: () => state.drainCleared,
    recordUpgradeRoster,
}));

vi.mock('../../terminal/host-service', () => ({
    hostBackendKind: () => 'detached',
    detachedHostPinsBinary: () => false,
}));
vi.mock('../../terminal/quit-confirm', () => ({ liveHostTerminals: () => [] }));
vi.mock('../git-updater', () => ({
    updater: () => ({
        setConfig: () => {},
        startPolling: () => {},
        getStatus: () => ({}),
        getConfig: () => ({ repo: 'r', pollHours: 6 }),
        on: () => {},
    }),
}));
vi.mock('../auto-updater', () => ({
    autoUpdaterInstance: () => ({
        setInterruptionProbe: () => {},
        setBeforeApply: (fn: () => void) => {
            state.beforeApply = fn;
        },
        startPolling: () => {},
        getStatus: () => ({}),
        restartAndApply: () => {},
        downloadAndInstall: async () => {},
        checkForUpdate: async () => {},
        on: () => {},
    }),
    updaterMode: () => 'phase2',
}));
vi.mock('../../db', () => ({
    getAllSettings: () => ({}),
    setSettings: () => {},
    getTerminalSpec: () => null,
}));
vi.mock('../../tray', () => ({ setUpdateAvailable: () => {} }));
vi.mock('../../background', () => ({
    showSettingsWindow: () => {},
    showMasterWindow: () => {},
}));
vi.mock('../changelog', () => ({ getChangelog: async () => ({}) }));
vi.mock('../../mobile/bus', () => ({ mobileEmit: () => {} }));

import { registerUpdaterIpc } from '../ipc';

beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    state.beforeApply = null;
    state.drainCleared = false;
});

describe('registerUpdaterIpc — the restore roster', () => {
    it('registers a pre-apply hook at all', () => {
        registerUpdaterIpc();
        expect(state.beforeApply).toBeTypeOf('function');
    });

    it('RECORDS the roster when the upgrade applies without a drain', () => {
        registerUpdaterIpc();
        state.drainCleared = false;
        state.beforeApply!();
        expect(recordUpgradeRoster).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-record once a drain has cleared — that would empty the list', () => {
        registerUpdaterIpc();
        state.drainCleared = true;
        state.beforeApply!();
        expect(recordUpgradeRoster).not.toHaveBeenCalled();
    });
});
