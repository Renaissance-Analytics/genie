import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Claude Channel binding's LIFETIME, end to end — genie#528.
 *
 * `agentinbox/__tests__/harness-transport.test.ts` proves the liveness rule
 * itself. This proves the thing that rule is useless without: that the real
 * `receive` path actually reports a parked poll, and reports it only for a poll
 * that is genuinely parked.
 *
 * The bug it closes: `registerTransport` mints a binding, and nothing ever
 * expired it. The two release paths in `terminal/ipc.ts` fire on pty exit and on
 * terminal kill, which is the common case — but the bridge is spawned by Claude
 * Code, not by Genie, and can stop while its pty lives on (a 401/403 sets
 * `process.exitCode`; a closed stdin ends its loop). Neither reaches Genie, so
 * `harnessAttached` stayed true and AgentInbox handed mail to a channel nobody
 * was listening to, with the PTY fallback suppressed behind it.
 *
 * REAL: the SQLite database and its migrations, the agent + terminal rows, the
 * AgentInbox broker and its long-poll, the harness-transport registry, and the
 * MCP tool handler that joins them.
 * FAKED: the pty process, the approval modal, and the clock.
 */

interface FakePty {
    pid: number;
    process: string;
    killed: boolean;
    written: string[];
    exit(): void;
    onData(cb: (d: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    write(d: string): void;
    resize(c: number, r: number): void;
    kill(): void;
}

const spawnedPtys: FakePty[] = [];

vi.mock('node-pty', () => ({
    spawn: (): FakePty => {
        let onExit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
        const pty: FakePty = {
            pid: 5000 + spawnedPtys.length,
            process: 'fake-shell',
            killed: false,
            written: [],
            onData: () => {},
            onExit: (cb) => {
                onExit = cb;
            },
            write(d: string) {
                this.written.push(d);
            },
            resize: () => {},
            kill() {
                this.killed = true;
                onExit?.({ exitCode: 0 });
            },
            exit() {
                this.killed = true;
                onExit?.({ exitCode: 0 });
            },
        };
        spawnedPtys.push(pty);
        return pty;
    },
}));

vi.mock('../../ask/force-question', () => ({
    forceQuestion: async () => ({ cancelled: false, answers: [{ selected: ['Approve'] }] }),
}));

// host-tools' import graph reaches main/tray.ts, which runs the Electron app
// bootstrap at MODULE LOAD. Cut the chain here.
vi.mock('../../tray', () => ({
    rebuildMenu: vi.fn(),
    createTray: vi.fn(),
    setInboxBadge: vi.fn(),
    setUpdateAvailable: vi.fn(),
}));

import { app } from 'electron';
import {
    addWorkspace,
    createTerminalSpec,
    deleteTerminalSpec,
    deleteWorkspaceAgent,
    getTerminalSpec,
    initDatabase,
    listTerminalSpecs,
    listWorkspaceAgents,
    setSettings,
    setWorkspaceAgentCap,
} from '../../db';
import { agentInboxForMcp, registerAgentForMcp, runAgentForMcp } from '../host-tools';
import { agentInboxBroker } from '../../agentinbox/broker';
import {
    harnessTransportRegistry,
    PULL_LIVENESS_GRACE_MS,
} from '../../agentinbox/harness-transport';
import { terminalManager } from '@particle-academy/fancy-term-host';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-channel-liveness-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });

(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const WS_ID = 'ws-channel-liveness';
const CALLER_ID = 'term-channel-caller';
const AGENT_NAME = 'channel-agent';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Channel liveness',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Channel liveness',
    shape: 'simple',
    path: wsDir,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

/**
 * One Claude agent in the state a connected one is really in: a live pty, an
 * AgentInbox identity, and a channel that has completed its handshake through
 * the actual `registerTransport` path rather than a hand-placed binding.
 */
async function connectedChannelAgent(): Promise<{ specId: string; inboxId: string }> {
    const registered = await registerAgentForMcp(CALLER_ID, {
        name: AGENT_NAME,
        purpose: 'Holds a Claude Channel',
        agent: 'claude',
    });
    if (!registered.ok) throw new Error(`fixture failed to register: ${registered.error}`);
    // An explicit command so nothing depends on a `claude` binary existing.
    const started = await runAgentForMcp(CALLER_ID, {
        action: 'start',
        name: AGENT_NAME,
        command: 'echo agent',
    });
    if (!started.ok || !started.id) throw new Error(`fixture failed to start: ${started.error}`);
    const specId = started.id;
    const inboxId = getTerminalSpec(specId)?.meta?.agent_id;
    if (typeof inboxId !== 'string') throw new Error('fixture: the spec has no AgentInbox identity');

    const handshake = await agentInboxForMcp(specId, {
        action: 'registerTransport',
        transport: 'claude-channel',
    });
    if (!handshake.ok) throw new Error(`fixture failed to handshake: ${handshake.error}`);
    return { specId, inboxId };
}

beforeEach(() => {
    terminalManager().killAll();
    for (const s of listTerminalSpecs()) deleteTerminalSpec(s.id);
    for (const agent of listWorkspaceAgents(WS_ID)) deleteWorkspaceAgent(agent.id);
    spawnedPtys.length = 0;
    setSettings({ max_agent_terminals: '' });
    setWorkspaceAgentCap(WS_ID, 'unlimited');

    createTerminalSpec({
        id: CALLER_ID,
        workspace_id: WS_ID,
        label: 'caller',
        cwd: wsDir,
        type: 'terminal',
        meta: {},
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('a Claude Channel binding lives only while something polls for it (genie#528)', () => {
    it('POSITIVE CONTROL: the handshake alone makes the agent attached', async () => {
        // Load-bearing. Every "it goes stale" assertion below is only meaningful
        // because this one shows a real channel registering through the real
        // path and being seen — a fix that bound nothing would pass a one-sided
        // staleness test perfectly.
        const { inboxId } = await connectedChannelAgent();

        expect(harnessTransportRegistry.isVerified(inboxId, 'claude-channel')).toBe(true);
        expect(harnessTransportRegistry.deliveryModeFor(inboxId)).toBe('pull');
    });

    it('goes stale when the bridge stops polling, though its pty lives on', async () => {
        // THE BUG. Nothing here kills the terminal — `feedTerminalExit` and
        // `killTerminalById` never run, which is precisely why this state used
        // to last until Genie restarted.
        const { specId, inboxId } = await connectedChannelAgent();
        vi.useFakeTimers();

        vi.advanceTimersByTime(PULL_LIVENESS_GRACE_MS + 1_000);

        expect(harnessTransportRegistry.isVerified(inboxId)).toBe(false);
        expect(harnessTransportRegistry.deliveryModeFor(inboxId)).toBeNull();
        // The pty really is still alive — this is the bridge dying underneath a
        // running agent, not a terminal going away.
        expect(getTerminalSpec(specId)).toBeTruthy();
        expect(spawnedPtys.at(-1)?.killed).toBe(false);
    });

    it('POSITIVE CONTROL: a parked long-poll holds the binding live for as long as it waits', async () => {
        // The case a "last completed receive" deadline gets wrong. The bridge
        // polls for minutes at a time and says NOTHING while it waits; if that
        // read as death, Genie would type a healthy channel's mail at its prompt
        // every few minutes.
        const { inboxId } = await connectedChannelAgent();
        vi.useFakeTimers();

        const parked = agentInboxForMcp(inboxIdSpec(inboxId), {
            action: 'receive',
            wait: true,
            timeoutMs: 600_000,
        });
        // Let the handler reach its `await` on the broker's long-poll.
        await vi.advanceTimersByTimeAsync(1);

        vi.advanceTimersByTime(PULL_LIVENESS_GRACE_MS * 5);

        expect(harnessTransportRegistry.isVerified(inboxId, 'claude-channel')).toBe(true);
        expect(harnessTransportRegistry.deliveryModeFor(inboxId)).toBe('pull');

        // ...and once that poll returns with no successor, it ages out.
        await vi.advanceTimersByTimeAsync(600_000);
        await expect(parked).resolves.toMatchObject({ ok: true });
        vi.advanceTimersByTime(PULL_LIVENESS_GRACE_MS + 1_000);

        expect(harnessTransportRegistry.isVerified(inboxId)).toBe(false);
    });

    it('does not let a NON-waiting receive prop up a dead channel', async () => {
        // An agent reading its own inbox by hand is not evidence its bridge is
        // up. Counting it would keep a stale binding alive and go on swallowing
        // the agent's mail — the expensive direction to be wrong in.
        const { inboxId } = await connectedChannelAgent();
        vi.useFakeTimers();
        vi.advanceTimersByTime(PULL_LIVENESS_GRACE_MS + 1_000);

        const read = await agentInboxForMcp(inboxIdSpec(inboxId), {
            action: 'receive',
            wait: false,
        });

        expect(read.ok).toBe(true);
        expect(harnessTransportRegistry.isVerified(inboxId)).toBe(false);
    });

    it('comes back when the bridge reconnects and polls again', async () => {
        // The channel recovering under its own steam, with no restart: the
        // binding is reported dead, never deleted, so the next poll revives it.
        const { inboxId } = await connectedChannelAgent();
        vi.useFakeTimers();
        vi.advanceTimersByTime(PULL_LIVENESS_GRACE_MS + 1_000);
        expect(harnessTransportRegistry.isVerified(inboxId)).toBe(false);

        const parked = agentInboxForMcp(inboxIdSpec(inboxId), {
            action: 'receive',
            wait: true,
            timeoutMs: 600_000,
        });
        await vi.advanceTimersByTimeAsync(1);

        expect(harnessTransportRegistry.isVerified(inboxId, 'claude-channel')).toBe(true);

        await vi.advanceTimersByTimeAsync(600_000);
        await parked;
    });
});

/** The agent's own terminal — the caller a bridge polls as. */
function inboxIdSpec(inboxId: string): string {
    const spec = listTerminalSpecs().find((s) => s.meta?.agent_id === inboxId);
    if (!spec) throw new Error('fixture: no terminal holds that AgentInbox identity');
    return spec.id;
}

// Keep the broker's module-level state from leaking between files.
afterEach(() => {
    agentInboxBroker.leaveByTerminal(CALLER_ID);
});
