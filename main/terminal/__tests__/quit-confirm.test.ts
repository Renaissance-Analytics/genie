import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Manual-quit terminal confirmation (T3) decision layer.
 *
 * On a MANUAL quit, a host-backed Genie with ≥1 live terminal + a window open
 * must ASK the user which detached terminals to keep running vs shut down,
 * default-keep-all. On confirm, the non-kept ids are killed via the host client
 * and the kept ones are left for the normal leave-running teardown. The update
 * path, the in-process backend, the no-terminals case, and the no-window case
 * must all SKIP the dialog.
 *
 * These tests mock the @particle-academy/fancy-term-host exports the module
 * uses (getHostClient → list()/kill()) and electron's BrowserWindow, then assert
 * shouldConfirmQuit / liveHostTerminals / applyQuitDecision / pickDialogWindow
 * behaviour directly. The full before-quit wiring lives in background.ts and is
 * exercised by gating on these same predicates.
 */

// --- mock state the shims read/write ---------------------------------------
type DecisionListener = (e: unknown, decision: unknown) => void;

const state: {
    client: {
        list: () => Array<{ id: string; pid: number; shell: string }>;
        kill: (id: string) => boolean;
    } | null;
    killed: string[];
    windows: Array<{ isDestroyed: () => boolean }>;
    focused: { isDestroyed: () => boolean } | null;
    // ipcMain listeners registered on the quit-decision channel.
    ipcListeners: Set<DecisionListener>;
} = {
    client: null,
    killed: [],
    windows: [],
    focused: null,
    ipcListeners: new Set(),
};

vi.mock('@particle-academy/fancy-term-host', () => ({
    getHostClient: () => state.client,
}));

vi.mock('electron', () => ({
    BrowserWindow: {
        getAllWindows: () => state.windows,
        getFocusedWindow: () => state.focused,
    },
    ipcMain: {
        on: (_channel: string, fn: DecisionListener) =>
            state.ipcListeners.add(fn),
        removeListener: (_channel: string, fn: DecisionListener) =>
            state.ipcListeners.delete(fn),
    },
}));

import {
    shouldConfirmQuit,
    liveHostTerminals,
    applyQuitDecision,
    pickDialogWindow,
    confirmQuitTerminals,
    CONFIRM_QUIT_CHANNEL,
    type LiveHostTerminal,
} from '../quit-confirm';

/** Deliver a renderer decision to the registered ipcMain listener(s). */
function deliverDecision(decision: unknown): void {
    for (const fn of [...state.ipcListeners]) fn({}, decision);
}

function fakeClient(
    list: Array<{ id: string; pid: number; shell: string }>,
) {
    return {
        list: () => list,
        kill: (id: string) => {
            state.killed.push(id);
            return true;
        },
    };
}

beforeEach(() => {
    state.client = null;
    state.killed = [];
    state.windows = [];
    state.focused = null;
    state.ipcListeners = new Set();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('liveHostTerminals', () => {
    it('maps the host client list to {id,pid,shell}', () => {
        state.client = fakeClient([
            { id: 'a', pid: 11, shell: 'bash' },
            { id: 'b', pid: 22, shell: 'pwsh' },
        ]);
        expect(liveHostTerminals()).toEqual([
            { id: 'a', pid: 11, shell: 'bash' },
            { id: 'b', pid: 22, shell: 'pwsh' },
        ]);
    });

    it('is empty when there is no host client (in-process)', () => {
        state.client = null;
        expect(liveHostTerminals()).toEqual([]);
    });

    it('is empty (never throws) when list() throws', () => {
        state.client = {
            list: () => {
                throw new Error('socket gone');
            },
            kill: () => true,
        };
        expect(liveHostTerminals()).toEqual([]);
    });
});

describe('shouldConfirmQuit', () => {
    const oneTerm: LiveHostTerminal[] = [{ id: 'a', pid: 1, shell: 'bash' }];

    it('confirms when host-backed + ≥1 live terminal + a window open', () => {
        expect(
            shouldConfirmQuit({
                hostBacked: true,
                liveTerminals: oneTerm,
                hasOpenWindow: true,
            }),
        ).toBe(true);
    });

    it('skips when NOT host-backed (in-process — nothing survives a quit)', () => {
        expect(
            shouldConfirmQuit({
                hostBacked: false,
                liveTerminals: oneTerm,
                hasOpenWindow: true,
            }),
        ).toBe(false);
    });

    it('skips when there are no live terminals', () => {
        expect(
            shouldConfirmQuit({
                hostBacked: true,
                liveTerminals: [],
                hasOpenWindow: true,
            }),
        ).toBe(false);
    });

    it('skips when no window is open (no-window tray-quit fallback)', () => {
        expect(
            shouldConfirmQuit({
                hostBacked: true,
                liveTerminals: oneTerm,
                hasOpenWindow: false,
            }),
        ).toBe(false);
    });
});

describe('applyQuitDecision', () => {
    const live: LiveHostTerminal[] = [
        { id: 'keep1', pid: 1, shell: 's' },
        { id: 'kill1', pid: 2, shell: 's' },
        { id: 'kill2', pid: 3, shell: 's' },
        { id: 'keep2', pid: 4, shell: 's' },
    ];

    it('kills every live id NOT in keepIds and leaves the kept ones', () => {
        state.client = fakeClient(live.map((t) => ({ ...t })));
        const killed = applyQuitDecision(live, ['keep1', 'keep2']);
        expect(new Set(killed)).toEqual(new Set(['kill1', 'kill2']));
        expect(new Set(state.killed)).toEqual(new Set(['kill1', 'kill2']));
    });

    it('keeps ALL running when keepIds covers every live id (default behaviour)', () => {
        state.client = fakeClient(live.map((t) => ({ ...t })));
        const killed = applyQuitDecision(
            live,
            live.map((t) => t.id),
        );
        expect(killed).toEqual([]);
        expect(state.killed).toEqual([]);
    });

    it('kills ALL when keepIds is empty (shut-all-down convenience)', () => {
        state.client = fakeClient(live.map((t) => ({ ...t })));
        const killed = applyQuitDecision(live, []);
        expect(new Set(killed)).toEqual(
            new Set(['keep1', 'kill1', 'kill2', 'keep2']),
        );
    });

    it('is a no-op (no throw) when there is no host client', () => {
        state.client = null;
        expect(applyQuitDecision(live, ['keep1'])).toEqual([]);
    });

    it('swallows a kill() that throws and continues with the rest', () => {
        state.client = {
            list: () => [],
            kill: (id: string) => {
                if (id === 'kill1') throw new Error('already gone');
                state.killed.push(id);
                return true;
            },
        };
        const killed = applyQuitDecision(live, ['keep1', 'keep2']);
        // kill1 threw → not in the returned list; kill2 still killed.
        expect(killed).toEqual(['kill2']);
        expect(state.killed).toEqual(['kill2']);
    });
});

describe('pickDialogWindow', () => {
    const alive = () => ({ isDestroyed: () => false });
    const dead = () => ({ isDestroyed: () => true });

    it('prefers the focused window when present and alive', () => {
        const focused = alive();
        state.focused = focused;
        state.windows = [alive(), focused];
        expect(pickDialogWindow()).toBe(focused);
    });

    it('falls back to the first non-destroyed window when none focused', () => {
        const live = alive();
        state.focused = null;
        state.windows = [dead(), live];
        expect(pickDialogWindow()).toBe(live);
    });

    it('returns null when no window is open (no-window fallback)', () => {
        state.focused = null;
        state.windows = [];
        expect(pickDialogWindow()).toBeNull();
    });

    it('skips a destroyed focused window and picks a live one', () => {
        state.focused = dead();
        const live = alive();
        state.windows = [live];
        expect(pickDialogWindow()).toBe(live);
    });
});

describe('confirmQuitTerminals (orchestrator)', () => {
    const live: LiveHostTerminal[] = [
        { id: 'a', pid: 1, shell: 's' },
        { id: 'b', pid: 2, shell: 's' },
        { id: 'c', pid: 3, shell: 's' },
    ];

    it('broadcasts the live terminals to the window and registers a listener', () => {
        state.client = fakeClient(live.map((t) => ({ ...t })));
        const send = vi.fn();
        const p = confirmQuitTerminals({ liveTerminals: live, send });
        // The dialog payload carries the live terminals on the confirm channel.
        expect(send).toHaveBeenCalledWith(CONFIRM_QUIT_CHANNEL, {
            terminals: live,
        });
        expect(state.ipcListeners.size).toBe(1);
        // Resolve so the promise doesn't dangle.
        deliverDecision({ confirmed: true, keepIds: live.map((t) => t.id) });
        return p;
    });

    it('on confirm: kills the deselected ids, leaves the kept, resolves "proceed"', async () => {
        state.client = fakeClient(live.map((t) => ({ ...t })));
        const p = confirmQuitTerminals({ liveTerminals: live, send: vi.fn() });
        deliverDecision({ confirmed: true, keepIds: ['a', 'c'] });
        const outcome = await p;
        expect(outcome).toBe('proceed');
        // 'b' was deselected → killed; 'a'/'c' left running.
        expect(state.killed).toEqual(['b']);
        // Listener torn down on resolve.
        expect(state.ipcListeners.size).toBe(0);
    });

    it('on confirm with keep-all: kills nothing (default behaviour)', async () => {
        state.client = fakeClient(live.map((t) => ({ ...t })));
        const p = confirmQuitTerminals({ liveTerminals: live, send: vi.fn() });
        deliverDecision({ confirmed: true, keepIds: live.map((t) => t.id) });
        expect(await p).toBe('proceed');
        expect(state.killed).toEqual([]);
    });

    it('on cancel: kills NOTHING and resolves "cancelled"', async () => {
        state.client = fakeClient(live.map((t) => ({ ...t })));
        const p = confirmQuitTerminals({ liveTerminals: live, send: vi.fn() });
        deliverDecision({ confirmed: false, keepIds: [] });
        const outcome = await p;
        expect(outcome).toBe('cancelled');
        expect(state.killed).toEqual([]);
        expect(state.ipcListeners.size).toBe(0);
    });

    it('on no response within the timeout: leaves ALL running, resolves "proceed"', async () => {
        vi.useFakeTimers();
        try {
            state.client = fakeClient(live.map((t) => ({ ...t })));
            const p = confirmQuitTerminals({
                liveTerminals: live,
                send: vi.fn(),
                timeoutMs: 30_000,
            });
            // No decision delivered — advance past the timeout.
            await vi.advanceTimersByTimeAsync(30_000);
            const outcome = await p;
            expect(outcome).toBe('proceed');
            // Safe default: nothing killed.
            expect(state.killed).toEqual([]);
            expect(state.ipcListeners.size).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores a second decision after the first settles', async () => {
        state.client = fakeClient(live.map((t) => ({ ...t })));
        const p = confirmQuitTerminals({ liveTerminals: live, send: vi.fn() });
        const fn = [...state.ipcListeners][0];
        deliverDecision({ confirmed: true, keepIds: ['a'] });
        await p;
        const killedAfterFirst = [...state.killed];
        // A late/stray second decision must be a no-op (listener already removed),
        // but even calling it directly must not double-kill.
        fn({}, { confirmed: true, keepIds: [] });
        expect(state.killed).toEqual(killedAfterFirst);
    });

    it('falls back to "proceed" + leave-all when send() throws (window torn down)', async () => {
        state.client = fakeClient(live.map((t) => ({ ...t })));
        const outcome = await confirmQuitTerminals({
            liveTerminals: live,
            send: () => {
                throw new Error('webContents gone');
            },
        });
        expect(outcome).toBe('proceed');
        expect(state.killed).toEqual([]);
        expect(state.ipcListeners.size).toBe(0);
    });
});
