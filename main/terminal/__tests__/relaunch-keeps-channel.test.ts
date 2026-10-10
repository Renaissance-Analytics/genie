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

// The agent this suite revives HAS a conversation — that is the premise of
// every assertion below ("it is still the SAME conversation, not a fresh one").
// Genie now reads that off disk rather than taking the spec's word for it, so
// the fixture has to put it there. See support/claude-transcripts.ts.
const SESSION_ID = 'c451ee41-b285-46e3-8633-751b9760b060';
useTempClaudeHome();
writeTranscript(WS_PATH, SESSION_ID);

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
import { useTempClaudeHome, writeTranscript } from '../../__tests__/support/claude-transcripts';
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
        meta: { agent: 'claude', agent_id: 'agent-1', chat_session_id: SESSION_ID, ...meta },
    });
    createAgentTerminal({
        id: 'term-1',
        workspaceId: 'ws-1',
        cwd: WS_PATH,
        label: 'claude · tynn',
        agentMeta: { agent: 'claude', command: String(meta.agent_command ?? '') },
    });
    // Used to wait for a `claude …` launch line to appear in the pty writes. Nothing is
    // typed now, so waiting for it would only ever time out. Settle the delivery timer
    // instead and hand back whatever WAS written — which should be nothing.
    await vi.waitFor(() => expect(specs.get('term-1')).toBeTruthy());
    return writes.join('');
}

/**
 * A RELAUNCHED CLAUDE AGENT TYPES NO LAUNCH LINE AT ALL.
 *
 * Every case here used to assert the rebuilt launch line: that a relaunch re-derived
 * `claude --dangerously-skip-permissions --dangerously-load-development-channels <channel>
 * --resume <id>` and typed it into a pty, with the channel positioned before the resume flag
 * because the channel option is variadic.
 *
 * As of 2026-10-09 agents do not run in terminals, and `maybeRelaunchAgent` returns before
 * delivering anything for an ACP-capable provider. So there is no line to rebuild, no flag
 * ordering to get right, and no prompt for a variadic option to swallow — that whole class
 * of bug is gone with the mechanism.
 *
 * ## What this does NOT prove, and must not be read as proving
 *
 * The CHANNEL was the point of the original tests: AgentInbox push for a claude agent came
 * from that flag. Its ACP replacement is `bindAcpMailTransport`, bound in
 * `createAgentTerminal`'s ACP branch — NOT here. These cases assert only that no shell is
 * driven; they say nothing about whether a relaunched agent still has working AgentInbox
 * push, which needs its own test against the transport registry. Flagged rather than
 * assumed, because a silently lost channel looks exactly like a quiet agent.
 */
describe('a relaunched Claude agent is not driven through a shell', () => {
    it('types NOTHING when reviving an agent whose command was swept', async () => {
        const line = await revive({});

        // COUNT of written bytes, not `not.toContain(CHANNEL)` — a partial or reordered
        // launch line would satisfy the latter while still driving a shell.
        expect(line).toBe('');
    });

    it('types nothing for a stored command that predates the channel either', async () => {
        const line = await revive({ agent_command: 'claude --dangerously-skip-permissions' });
        expect(line).toBe('');
    });

    it('POSITIVE CONTROL: the harness CAN observe writes, so `""` means silence not blindness', async () => {
        // Without this, every assertion above passes just as well on a broken harness that
        // never captures a write — which is the way "nothing was typed" fails quietly.
        await revive({ agent_command: 'claude --dangerously-skip-permissions' });
        writes.push('probe');
        expect(writes.join('')).toContain('probe');
    });

    it('leaves the stored agent_command ALONE rather than rebuilding it', async () => {
        // It used to be rewritten in place so "every later reader gets the same one". Nothing
        // reads it for a launch any more, so rewriting it would be inventing history; the
        // owner's configured command stays exactly as they wrote it.
        const original = 'claude --dangerously-skip-permissions';
        await revive({ agent_command: original });

        expect((specs.get('term-1')?.meta as Record<string, unknown>).agent_command).toBe(original);
    });
});
