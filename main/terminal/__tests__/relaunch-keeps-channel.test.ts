import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A relaunched Claude agent comes back WITH its AgentInbox channel.
 *
 * Genie relaunches every saved agent after an upgrade ("Genie just RESTARTED
 * you"), and that relaunch replays the spec's stored `meta.agent_command`. Two
 * migrations (v59, v65) DELETE that command when the flags it froze go bad, on
 * the stated assumption that "resolution falls through to the builder". The
 * restart TOOL does fall through (host-tools); this path never did. It handed
 * `''` to the resume renderer, which fell back to the registry's bare default,
 * so a swept agent came back as `claude --resume <id>`:
 *
 *   - no `--dangerously-load-development-channels server:genie-agentinbox-channel`,
 *     so Claude Code loaded the bridge as an ordinary MCP server and silently
 *     dropped every channel notification — and AgentInbox, reading the bridge
 *     as live, fell back to typing each DM into the agent's prompt;
 *   - none of the owner's always-on flags (`--dangerously-skip-permissions`).
 *
 * Measured on the owner's machine before this was written: five Claude agents
 * running as `claude.exe --resume <id> "Genie just RESTARTED you…"`, each with a
 * spec whose `agent_command` was gone.
 *
 * A stored command that predates the channel had the same hole by another road:
 * the channel was only ever added when the command was first BUILT.
 */

vi.mock('electron', () => ({
    ipcMain: { handle: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    WebContents: class {},
}));

const writes: string[] = [];

vi.mock('node-pty', () => ({
    spawn: () => {
        let onExit: ((e: { exitCode: number }) => void) | null = null;
        return {
            pid: 1,
            process: 'fake',
            killed: false,
            onData: () => {},
            onExit: (cb: (e: { exitCode: number }) => void) => {
                onExit = cb;
            },
            write: (data: string) => {
                writes.push(data);
            },
            resize: () => {},
            kill() {
                this.killed = true;
                onExit?.({ exitCode: 0 });
            },
        };
    },
}));

const WS_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-relaunch-channel-'));
fs.mkdirSync(path.join(WS_PATH, '.agents', '_genie'), { recursive: true });
fs.writeFileSync(path.join(WS_PATH, '.agents', '_genie', 'agentinbox-claude-channel.cjs'), '// bridge');

let settings: Record<string, string> = {};
const specs = new Map<string, Record<string, unknown>>();

vi.mock('../../db', () => ({
    getAllSettings: () => ({ track_cwd: 'off', ...settings }),
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
    getWorkspace: (id: string) => (id === 'ws-1' ? { id: 'ws-1', path: WS_PATH, project_id: null } : null),
    // This is about the launch LINE, not the per-terminal endpoint.
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

const CHANNEL = '--dangerously-load-development-channels server:genie-agentinbox-channel';

beforeEach(() => {
    writes.length = 0;
    specs.clear();
    settings = { agent_flags_claude: '--dangerously-skip-permissions' };
    terminalManager().killAll();
});

afterEach(() => {
    terminalManager().killAll();
});

afterAll(() => {
    fs.rmSync(WS_PATH, { recursive: true, force: true });
});

/** A saved Claude agent whose pty has died, revived the way an upgrade does. */
async function revive(meta: Record<string, unknown>): Promise<string> {
    specs.set('term-1', {
        id: 'term-1',
        workspace_id: 'ws-1',
        label: 'claude · tynn',
        cwd: WS_PATH,
        type: 'terminal',
        meta: { agent: 'claude', agent_id: 'agent-1', chat_session_id: 'c451ee41-b285-46e3-8633-751b9760b060', ...meta },
    });
    createAgentTerminal({
        id: 'term-1',
        workspaceId: 'ws-1',
        cwd: WS_PATH,
        label: 'claude · tynn',
        agentMeta: { agent: 'claude', command: String(meta.agent_command ?? '') },
    });
    let line = '';
    await vi.waitFor(() => {
        line = writes.join('');
        expect(line).toMatch(/claude/);
    });
    return line;
}

describe('a relaunched Claude agent keeps its AgentInbox channel', () => {
    it('rebuilds a swept launch command instead of resuming a bare `claude`', async () => {
        const line = await revive({});

        expect(line).toContain(CHANNEL);
        expect(line).toContain('--dangerously-skip-permissions');
        // It is still the SAME conversation, not a fresh one.
        expect(line).toMatch(/--resume|--continue/);
    });

    it('keeps the rebuilt command, so every later reader gets the same one', async () => {
        await revive({});

        const stored = (specs.get('term-1')?.meta as Record<string, unknown>).agent_command;
        expect(stored).toContain(CHANNEL);
        expect(stored).toContain('--dangerously-skip-permissions');
    });

    it('adds the channel to a stored command that predates it', async () => {
        const line = await revive({ agent_command: 'claude --dangerously-skip-permissions' });

        expect(line).toContain(CHANNEL);
        // The channel takes a VARIADIC list, so it must not be the last option
        // before the relaunch prompt — the prompt would be read as a channel.
        expect(line.indexOf(CHANNEL)).toBeLessThan(line.search(/--resume|--continue/));
    });

    it('POSITIVE CONTROL: no channel when the owner turned Claude sync off', async () => {
        // Otherwise "the line contains the channel" would pass against a builder
        // that appends it unconditionally.
        settings = { ...settings, mcp_sync_claude: 'off' };

        const line = await revive({ agent_command: 'claude --dangerously-skip-permissions' });

        expect(line).toContain('--dangerously-skip-permissions');
        expect(line).not.toContain(CHANNEL);
    });
});
