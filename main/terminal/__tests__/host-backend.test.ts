import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 3 — backend selection + graceful fallback.
 *
 *   • Setting OFF (default)            → in-process backend, host:false.
 *   • Setting ON but host unavailable  → fall back to in-process, host:false,
 *                                        and a non-fatal toast is broadcast.
 *
 * We drive initTerminalBackend with a mocked settings source and a mocked
 * host-script resolver (returns null → "host not found" branch, which is the
 * cleanest unavailable case that doesn't spawn a real process). The electron
 * stub's BrowserWindow.getAllWindows() returns [] so the toast broadcast is a
 * harmless no-op we can still assert was attempted via the captured windows.
 */

let settings: Record<string, string> = {};
vi.mock('../../db', () => ({
    getAllSettings: () => settings,
    updateTerminalSpec: () => null,
}));

// Capture toast broadcasts by spying on a fake window's webContents.send.
const sent: Array<{ channel: string; payload: unknown }> = [];
vi.mock('electron', () => ({
    app: {
        getPath: () => '/tmp/genie-userdata',
    },
    BrowserWindow: {
        getAllWindows: () => [
            {
                isDestroyed: () => false,
                webContents: {
                    send: (channel: string, payload: unknown) =>
                        sent.push({ channel, payload }),
                },
            },
        ],
    },
}));

// Force the "host script not found" branch so no real process is spawned.
vi.mock('../host-locate', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../host-locate')>();
    return {
        ...actual,
        resolveHostScript: () => null,
        // Pretend there's no existing host so we take the spawn branch (which
        // then hits the null-script guard → fallback).
        readPidfile: () => null,
        pidfileUsable: () => false,
    };
});

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

vi.mock('../sessions', () => ({
    readSnapshot: () => null,
    writeSnapshot: () => 1,
    deleteSnapshot: () => undefined,
}));

import { initTerminalBackend, isHostBacked } from '../host-lifecycle';
import { terminalManager, inProcessBackend } from '../manager';

beforeEach(() => {
    settings = {};
    sent.length = 0;
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
        expect(sent.some((s) => s.channel === 'terminal:host-status')).toBe(false);
    });

    it('setting ON but host unavailable → fallback to in-process + toast', async () => {
        settings = { detached_terminals: 'on' };
        const res = await initTerminalBackend();
        expect(res.host).toBe(false);
        expect(isHostBacked()).toBe(false);
        expect(terminalManager()).toBe(inProcessBackend());
        // A non-fatal fallback toast was broadcast.
        const toast = sent.find((s) => s.channel === 'terminal:host-status');
        expect(toast).toBeTruthy();
        expect((toast!.payload as { message: string }).message).toMatch(
            /in-process/i,
        );
    });
});
