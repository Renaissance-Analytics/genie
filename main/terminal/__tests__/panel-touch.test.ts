import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OPENING A PANEL RECORDS WHEN (genie#585).
 *
 * `terminal_specs.last_opened_at` was never written. The IPC to write it existed
 * and was plumbed to the renderer, and nothing called it — so every spec carried
 * `null`, and genie#577's panel cap, which claims to keep the MOST-RECENTLY-
 * ACTIVE panels when a restore is over `max_views`, fell through to panel order
 * for every workspace. Deterministic, but not what it promises: the panel you
 * were last working in had no better claim to a slot than one you had not opened
 * in a week.
 *
 * The write belongs where the event is — main, at the two seams a pty is
 * attached for a panel — rather than in a renderer that has to remember to call
 * it, which is exactly how it came to be called by nobody. Both seams matter:
 * `terminal:create` is a window (desktop or Stage) mounting a panel, and
 * `createAgentTerminal` is the same event reached from the MCP tools, a remote
 * window and mobile.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
    ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
            handlers.set(channel, fn);
        },
    },
    BrowserWindow: { getAllWindows: () => [] },
    WebContents: class {},
}));

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

const touched: string[] = [];
const specs = new Map<string, Record<string, unknown>>();

vi.mock('../../db', () => ({
    updateTerminalSpec: () => null,
    getAllSettings: () => ({ track_cwd: 'off' }),
    getTerminalSpec: (id: string) => specs.get(id) ?? null,
    listTerminalSpecs: () => [...specs.values()],
    listWorkspaces: () => [],
    getWorkspace: () => null,
    touchTerminalSpec: (id: string) => {
        touched.push(id);
    },
    isWorkspaceHibernated: () => false,
    workspaceMcpEnabled: () => false,
    getWorkspaceAgentAccess: () => null,
    markWorkspaceAgentTransportState: () => null,
    countAgentTerminals: () => 0,
}));

vi.mock('../genie-adapter', () => ({
    getSnapshotStore: () => ({
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    }),
    dbSettingsProvider: () => ({
        get: (k: string) => (k === 'track_cwd' ? 'off' : undefined),
    }),
}));

import { createAgentTerminal, registerTerminalIpc } from '../ipc';
import { configureInProcessBackend } from '@particle-academy/fancy-term-host';

configureInProcessBackend({
    settings: { get: (k) => (k === 'track_cwd' ? 'off' : undefined) },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    },
});

const fakeEvent = {
    sender: { once: () => {}, off: () => {}, isDestroyed: () => false },
};

function invoke<T = unknown>(channel: string, ...args: unknown[]): T {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn(fakeEvent, ...args) as T;
}

beforeEach(() => {
    touched.length = 0;
    specs.clear();
    handlers.clear();
    registerTerminalIpc();
});

describe('terminal:create — a window opening a panel', () => {
    it('records that the panel was opened, so the cap can rank by recency', () => {
        specs.set('panel-1', { id: 'panel-1', type: 'terminal', workspace_id: 'ws-1', cwd: '/ws' });

        invoke('terminal:create', { id: 'panel-1', cwd: '/ws' });

        expect(touched).toEqual(['panel-1']);
    });

    it('does not record a PROCESS runner — it has no panel and never competes for a slot', () => {
        specs.set('proc-1', {
            id: 'proc-1',
            type: 'process',
            workspace_id: 'ws-1',
            cwd: '/ws',
            meta: { command: 'npm run dev' },
        });

        invoke('terminal:create', { id: 'proc-1', cwd: '/ws' });

        expect(touched).toEqual([]);
    });
});

describe('createAgentTerminal — the same event, reached from an agent, a remote window or mobile', () => {
    it('records the open, so an agent panel ranks by recency like any other', () => {
        specs.set('agent-1', {
            id: 'agent-1',
            type: 'terminal',
            workspace_id: 'ws-1',
            cwd: '/ws',
            label: 'docs',
            meta: { agent: 'claude' },
        });

        createAgentTerminal({ id: 'agent-1', cwd: '/ws', workspaceId: 'ws-1', label: 'docs' });

        expect(touched).toEqual(['agent-1']);
    });
});
