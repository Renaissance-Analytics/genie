import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 2 — IPC layer tests for terminal:set-retained (cap enforcement) and the
 * terminal:kill snapshot-cleanup. We mock electron's ipcMain to capture the
 * registered handlers, then invoke them directly with a fake event.
 */

// Capture every ipcMain.handle registration so we can invoke handlers by name.
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
    ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
            handlers.set(channel, fn);
        },
    },
    BrowserWindow: {
        getAllWindows: () => [],
    },
    WebContents: class {},
}));

// node-pty fake so the manager can spawn without the native binding.
const spawned: Array<{ pid: number; process: string; killed: boolean }> = [];
vi.mock('node-pty', () => ({
    spawn: () => {
        let onExit: ((e: { exitCode: number }) => void) | null = null;
        const p = {
            pid: 1,
            process: 'fake',
            killed: false,
            onData: () => {},
            onExit: (cb: (e: { exitCode: number }) => void) => {
                onExit = cb;
            },
            write: () => {},
            resize: () => {},
            kill() {
                this.killed = true;
                onExit?.({ exitCode: 0 });
            },
        };
        spawned.push(p);
        return p;
    },
}));

vi.mock('../../db', () => ({
    updateTerminalSpec: () => null,
    getAllSettings: () => ({ track_cwd: 'off' }),
    // terminal:create resolves the spec to detect process-type runners; a plain
    // terminal spawn path doesn't need a row, so the mock returns null.
    getTerminalSpec: () => null,
    listWorkspaces: () => [],
}));

// Track deleteSnapshot calls so we can assert terminal:kill cleans up. ipc.ts
// now goes through the genie-adapter for its snapshot store + settings provider;
// mock the adapter with TEST-DOUBLE PORTS (in-memory snapshot store + a
// track_cwd-off settings provider) instead of mocking electron/sessions/db deep.
const deleted: string[] = [];
vi.mock('../genie-adapter', () => ({
    getSnapshotStore: () => ({
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: (id: string) => {
            deleted.push(id);
        },
    }),
    dbSettingsProvider: () => ({
        get: (k: string) => (k === 'track_cwd' ? 'off' : undefined),
    }),
}));

import { registerTerminalIpc, MAX_RETAINED } from '../ipc';
import { terminalManager, configureInProcessBackend } from '@particle-academy/fancy-term-host';

// Configure the in-process backend with the same test-double ports so create()
// in these IPC tests doesn't touch disk/db either.
configureInProcessBackend({
    settings: { get: (k) => (k === 'track_cwd' ? 'off' : undefined) },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    },
});

const fakeEvent = { sender: { once: () => {}, off: () => {}, isDestroyed: () => false } };

function invoke<T = unknown>(channel: string, ...args: unknown[]): T {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn(fakeEvent, ...args) as T;
}

beforeEach(() => {
    handlers.clear();
    deleted.length = 0;
    spawned.length = 0;
    const m = terminalManager();
    m.killAll();
    for (const id of m.retainedIds()) m.setRetained(id, false);
    registerTerminalIpc();
});

afterEach(() => {
    terminalManager().killAll();
});

type SetRetainedResult = {
    ok: boolean;
    retainedCount: number;
    max: number;
    reason?: string;
};

describe('terminal:set-retained', () => {
    it('toggles retention and reports the count', () => {
        const on = invoke<SetRetainedResult>('terminal:set-retained', 'a', true);
        expect(on.ok).toBe(true);
        expect(on.retainedCount).toBe(1);
        expect(terminalManager().isRetained('a')).toBe(true);

        const off = invoke<SetRetainedResult>('terminal:set-retained', 'a', false);
        expect(off.ok).toBe(true);
        expect(off.retainedCount).toBe(0);
        expect(terminalManager().isRetained('a')).toBe(false);
    });

    it('enforces the MAX_RETAINED cap and blocks the overflow', () => {
        for (let i = 0; i < MAX_RETAINED; i++) {
            const r = invoke<SetRetainedResult>('terminal:set-retained', `r${i}`, true);
            expect(r.ok).toBe(true);
        }
        expect(terminalManager().retainedCount()).toBe(MAX_RETAINED);

        // One past the cap is refused.
        const over = invoke<SetRetainedResult>('terminal:set-retained', 'overflow', true);
        expect(over.ok).toBe(false);
        expect(over.reason).toBeTruthy();
        expect(terminalManager().isRetained('overflow')).toBe(false);

        // Re-retaining an already-retained id is idempotent success (not blocked).
        const again = invoke<SetRetainedResult>('terminal:set-retained', 'r0', true);
        expect(again.ok).toBe(true);
    });
});

describe('terminal:kill', () => {
    it('kills the pty, clears retention, and deletes the snapshot', () => {
        invoke('terminal:create', { id: 'k', cwd: '/tmp', shell: '/bin/fake', args: [] });
        invoke('terminal:set-retained', 'k', true);
        expect(terminalManager().isLive('k')).toBe(true);

        invoke('terminal:kill', 'k');

        expect(terminalManager().isLive('k')).toBe(false);
        expect(terminalManager().isRetained('k')).toBe(false);
        expect(deleted).toContain('k');
    });
});
