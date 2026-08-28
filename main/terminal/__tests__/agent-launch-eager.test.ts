import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * genie #63 Phase 0 — the HOST launches an agent-created terminal, not the renderer.
 *
 * The proof-bug: an agent-created terminal's pty/CLI launch was effectively tied to
 * the renderer mounting the panel, because the only code that treats "a fresh pty for
 * an agent spec must have its agent launched" as a RULE was `maybeRelaunchAgent`, and
 * that is invoked exclusively from the `terminal:create` renderer-attach IPC handler.
 * `createAgentTerminal` itself merely RENDERED the launch command and handed it back
 * to whichever caller happened to remember to write it.
 *
 * These tests pin the Host-side contract with NO renderer in sight: creating an agent
 * terminal must leave the pty LIVE and must deliver the boot command into it.
 *
 * Mirrors retained-ipc.test.ts's harness: the REAL in-process backend from
 * fancy-term-host over a fake node-pty, so `create()` really spawns and `write()`
 * really lands on a pty we can inspect.
 */

vi.mock('electron', () => ({
    ipcMain: { handle: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    WebContents: class {},
}));

/** Every write the pty received, in order — this is what "the agent launched" means. */
const writes: Array<{ pid: number; data: string }> = [];
const spawned: Array<{ pid: number; killed: boolean }> = [];

vi.mock('node-pty', () => ({
    spawn: () => {
        let onExit: ((e: { exitCode: number }) => void) | null = null;
        const pid = spawned.length + 1;
        const p = {
            pid,
            process: 'fake',
            killed: false,
            onData: () => {},
            onExit: (cb: (e: { exitCode: number }) => void) => {
                onExit = cb;
            },
            write: (data: string) => {
                writes.push({ pid, data });
            },
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

vi.mock('../../agentinbox/codex-app-server-lifecycle', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../agentinbox/codex-app-server-lifecycle')>();
    return {
        ...actual,
        codexAppServerManager: {
            start: vi.fn(async () => ({
                address: 'ws://127.0.0.1:47891',
                session: { deliver: vi.fn(async () => undefined) },
            })),
            stop: vi.fn(),
        },
    };
});

// In-memory spec store so createAgentTerminal's persist → read-back works.
const specs = new Map<string, Record<string, unknown>>();
vi.mock('../../db', () => ({
    getAllSettings: () => ({ track_cwd: 'off' }),
    getTerminalSpec: (id: string) => specs.get(id) ?? null,
    createTerminalSpec: (row: Record<string, unknown>) => {
        specs.set(row.id as string, row);
        return row;
    },
    updateTerminalSpec: (id: string, patch: Record<string, unknown>) => {
        const cur = specs.get(id);
        if (cur) specs.set(id, { ...cur, ...patch });
        return specs.get(id) ?? null;
    },
    listTerminalSpecs: () => Array.from(specs.values()),
    listWorkspaceAgents: () => [],
    listWorkspaces: () => [],
    // No workspace row → no workspace .env load and no AgentInbox broker join;
    // this test is about the LAUNCH, not the identity plumbing.
    getWorkspace: () => null,
    workspaceMcpEnabled: () => false,
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

import { createAgentTerminal } from '../ipc';
import { terminalManager, configureInProcessBackend } from '@particle-academy/fancy-term-host';

configureInProcessBackend({
    settings: { get: (k) => (k === 'track_cwd' ? 'off' : undefined) },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    },
});

beforeEach(() => {
    vi.useFakeTimers();
    writes.length = 0;
    spawned.length = 0;
    specs.clear();
    terminalManager().killAll();
});

afterEach(() => {
    terminalManager().killAll();
    vi.useRealTimers();
});

/** Everything the pty was sent, concatenated. */
function delivered(): string {
    return writes.map((w) => w.data).join('');
}

describe('createAgentTerminal — the Host launches the agent (genie #63 Phase 0)', () => {
    it('spawns the pty AND delivers the boot command with no renderer attach', () => {
        const r = createAgentTerminal({
            workspaceId: 'ws-1',
            cwd: process.cwd(),
            label: 'claude agent',
            agentMeta: { agent: 'claude', command: 'claude' },
        });

        // The pty is LIVE in the Host the instant the agent created it.
        expect(terminalManager().isLive(r.id)).toBe(true);
        expect(spawned).toHaveLength(1);

        // ...and the agent CLI was launched into it. Nothing here attached a
        // viewer: no terminal:create IPC, no window, no renderer.
        vi.runAllTimers();
        expect(delivered()).toContain('claude --session-id');
        expect(delivered().endsWith('\r')).toBe(true);
    });

    it('renders Codex instructions after all options and launches its remote App Server TUI', async () => {
        const r = createAgentTerminal({
            workspaceId: 'ws-1',
            cwd: process.cwd(),
            label: 'codex agent',
            agentMeta: {
                agent: 'codex',
                command: 'codex --yolo -c model_reasoning_effort="high"',
                instructions: '--read AGENTS.md first',
            },
        });

        await vi.runAllTimersAsync();
        expect(r.command).toBe(
            'codex --yolo -c model_reasoning_effort="high" -- "read AGENTS.md first"',
        );
        expect(delivered()).toContain('--remote ws://127.0.0.1:');
        expect(delivered()).toContain('--remote-auth-token-env GENIE_CODEX_APP_TOKEN');
    });

    it('does not re-submit the boot command when the pty is already running', () => {
        const first = createAgentTerminal({
            workspaceId: 'ws-1',
            cwd: process.cwd(),
            label: 'claude agent',
            agentMeta: { agent: 'claude', command: 'claude' },
        });
        vi.runAllTimers();
        const afterFirst = writes.length;

        // Idempotent re-create on a LIVE id (a remote re-open / respawn probe):
        // typing the launch command again would land in the running TUI's prompt.
        const again = createAgentTerminal({
            id: first.id,
            workspaceId: 'ws-1',
            cwd: process.cwd(),
            label: 'claude agent',
            agentMeta: { agent: 'claude', command: 'claude' },
        });
        vi.runAllTimers();

        expect(again.existing).toBe(true);
        expect(writes).toHaveLength(afterFirst);
    });

    it('leaves a PLAIN terminal alone — no agentMeta, no boot command', () => {
        const r = createAgentTerminal({
            workspaceId: 'ws-1',
            cwd: process.cwd(),
            label: 'Agent terminal',
        });
        vi.runAllTimers();

        expect(terminalManager().isLive(r.id)).toBe(true);
        expect(writes).toHaveLength(0);
    });
});
