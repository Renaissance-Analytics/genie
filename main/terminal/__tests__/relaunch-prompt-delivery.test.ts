import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * genie#434, the CODEX half.
 *
 * Codex does not take its relaunch prompt on the command line, and this is not
 * a style choice — it is the only channel that exists. A reviving codex agent
 * goes down the App Server path (`preparedCodex`), which short-circuits BOTH
 * command-line delivery routes in `createAgentTerminal`: `maybeRelaunchAgent`
 * never runs, and the TUI that is eventually typed is
 * `codexRemoteTuiLaunch(<the STORED base command>, <address>)` — built from
 * `meta.agent_command`, so anything appended elsewhere is discarded. The thread
 * is resumed by `resumeThreadId` over the App Server, not by argv.
 *
 * So the prompt rides the channel codex already uses for mail:
 * `session.deliver`, which starts a turn on the resumed thread. That is a
 * VERIFIED shape — the very next thing this code path does is deliver the
 * AgentInbox backlog through it — rather than a positional argument nobody has
 * confirmed `codex --remote` accepts.
 */

vi.mock('electron', () => ({
    ipcMain: { handle: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    WebContents: class {},
}));

const writes: Array<{ pid: number; data: string }> = [];

vi.mock('node-pty', () => ({
    spawn: () => {
        let onExit: ((e: { exitCode: number }) => void) | null = null;
        const pid = writes.length + 1;
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
        return p;
    },
}));

/** Everything handed to the codex App Server session, in order. */
const delivered: Array<Record<string, unknown>> = [];

vi.mock('../../agentinbox/codex-app-server-lifecycle', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('../../agentinbox/codex-app-server-lifecycle')>();
    return {
        ...actual,
        codexAppServerManager: {
            start: vi.fn(async () => ({
                address: 'ws://127.0.0.1:47891',
                session: {
                    deliver: vi.fn(async (payload: Record<string, unknown>) => {
                        delivered.push(payload);
                    }),
                },
            })),
            stop: vi.fn(),
        },
    };
});

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
    getWorkspace: () => null,
    // The workspace CAN serve the genie tools — which is what makes a prompt
    // naming `connectToGenie` honest here (and what agent-launch-eager, which
    // is about the launch line rather than the prompt, deliberately turns off).
    workspaceMcpEnabled: () => true,
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
    writes.length = 0;
    delivered.length = 0;
    specs.clear();
    terminalManager().killAll();
});

afterEach(() => {
    terminalManager().killAll();
});

/** Create a codex agent, then bring it back the way a revive/restart does. */
async function reviveCodex(sessionId: string | null): Promise<string> {
    const first = createAgentTerminal({
        workspaceId: 'ws-1',
        cwd: process.cwd(),
        label: 'codex · relaunch',
        agentMeta: { agent: 'codex', command: 'codex --yolo' },
    });
    await vi.waitFor(() => expect(delivered.length).toBeGreaterThanOrEqual(0));
    // The App Server binds the thread id after launch (codex's hook strategy),
    // so a saved codex agent has one on its spec by the time it is revived.
    const cur = specs.get(first.id)!;
    specs.set(first.id, {
        ...cur,
        meta: { ...(cur.meta as Record<string, unknown>), ...(sessionId ? { chat_session_id: sessionId } : {}) },
    });
    terminalManager().kill(first.id);
    delivered.length = 0;

    createAgentTerminal({
        id: first.id,
        workspaceId: 'ws-1',
        cwd: process.cwd(),
        label: 'codex · relaunch',
        agentMeta: { agent: 'codex', command: 'codex --yolo' },
    });
    return first.id;
}

describe('codex relaunch prompt — genie#434', () => {
    it('delivers the reconnect-and-confirm turn onto the RESUMED thread', async () => {
        await reviveCodex('thread-abc');

        await vi.waitFor(() => {
            expect(delivered.length).toBeGreaterThan(0);
        });
        const text = String(delivered[0]?.text ?? '');
        expect(text).toContain('connectToGenie');
        expect(text).toContain('thumbsUp');
        expect(text).toMatch(/resumed/i);
    });

    it('does NOT send one on a first launch — that already carries its prompt', async () => {
        // POSITIVE CONTROL for the test above: a fresh create takes its
        // instructions on the command line (`withProviderStartupInstructions`),
        // so a relaunch turn here would be a second, contradictory opening.
        createAgentTerminal({
            workspaceId: 'ws-1',
            cwd: process.cwd(),
            label: 'codex · fresh',
            agentMeta: {
                agent: 'codex',
                command: 'codex --yolo',
                instructions: 'read AGENTS.md first',
            },
        });

        await vi.waitFor(() => {
            expect(writes.map((w) => w.data).join('')).toContain('--remote ws://127.0.0.1:');
        });
        expect(delivered).toHaveLength(0);
    });
});
