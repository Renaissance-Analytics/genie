import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Genie answers its development-channel warning in EVERY life of a terminal.
 *
 * Relaunching an agent reuses its terminal id — a revive, `runAgent start`, and
 * the restart tool all bring the agent back into the SAME spec, so its AgentInbox
 * identity survives. The record of "already answered" was keyed by that id and
 * never cleared, so the second launch in one Genie session sat on Claude Code's
 * full-screen warning with nobody to confirm it: the agent never started, and its
 * channel with it.
 *
 * "Answered once per pty" is still the rule — Ink repaints the dialog many times
 * and a second Enter lands in the session behind it — but a pty that exits has
 * been answered for, and the next one has not.
 */

vi.mock('electron', () => ({
    ipcMain: { handle: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    WebContents: class {},
}));

interface FakePty {
    emit(data: string): void;
    exit(code: number): void;
}
const ptys: FakePty[] = [];
const writes: string[] = [];

vi.mock('node-pty', () => ({
    spawn: () => {
        let onData: ((d: string) => void) | null = null;
        let onExit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
        const p = {
            pid: 5000 + ptys.length,
            process: 'fake',
            onData: (cb: (d: string) => void) => {
                onData = cb;
            },
            onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
                onExit = cb;
            },
            write: (data: string) => {
                writes.push(data);
            },
            resize: () => {},
            kill() {
                onExit?.({ exitCode: 0 });
            },
            emit(data: string) {
                onData?.(data);
            },
            exit(code: number) {
                onExit?.({ exitCode: code });
            },
        };
        ptys.push(p);
        return p;
    },
}));

vi.mock('../../db', () => ({
    updateTerminalSpec: () => null,
    getAllSettings: () => ({ track_cwd: 'off' }),
    getTerminalSpec: () => null,
    listTerminalSpecs: () => [],
    listWorkspaces: () => [],
    listWorkspaceAgents: () => [],
    getWorkspace: () => null,
    workspaceMcpEnabled: () => false,
    createTerminalSpec: () => null,
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

import { killTerminalById, subscribeHeadlessBackendEvents } from '../ipc';
import { AGENTINBOX_CHANNEL_ENTRY } from '../dev-channel-consent';
import { terminalManager, configureInProcessBackend } from '@particle-academy/fancy-term-host';

configureInProcessBackend({
    settings: { get: (k) => (k === 'track_cwd' ? 'off' : undefined) },
    snapshots: {
        readSnapshot: () => null,
        writeSnapshot: () => 1,
        deleteSnapshot: () => undefined,
    },
});
subscribeHeadlessBackendEvents();

const WARNING = [
    'WARNING: Loading development channels',
    '--dangerously-load-development-channels is for local channel development only.',
    'Do not use this option to run channels you have downloaded off the internet.',
    '',
    `Channels: ${AGENTINBOX_CHANNEL_ENTRY}`,
    '',
    '❯ 1. I am using this for local development',
    '  2. Exit',
].join('\r\n');

function spawn(id: string): FakePty {
    terminalManager().create({ id, cwd: process.cwd(), shell: 'fake' });
    return ptys[ptys.length - 1]!;
}

const confirms = (): number => writes.filter((w) => w === '\r').length;

beforeEach(() => {
    ptys.length = 0;
    writes.length = 0;
    terminalManager().killAll();
});

afterEach(() => {
    terminalManager().killAll();
});

describe('the development-channel warning, across relaunches of one terminal', () => {
    it('answers it once per pty, however often Ink repaints it', () => {
        const pty = spawn('agent-once');
        pty.emit(WARNING);
        pty.emit(WARNING);
        pty.emit(WARNING);

        expect(confirms()).toBe(1);
    });

    it('answers it again when the agent is relaunched after its pty EXITED', () => {
        spawn('agent-exit').emit(WARNING);
        ptys[0]!.exit(0);

        spawn('agent-exit').emit(WARNING);

        expect(confirms()).toBe(2);
    });

    it('does not answer the OLD warning still in the dead pty\'s retained tail', () => {
        // The exit keeps a tail of the final output (genie#217), and the warning
        // can be in it. The next life's first output must not be read as that
        // warning — an Enter typed into a shell before the agent has even started
        // would also use up the one answer its real warning needs.
        spawn('agent-tail').emit(WARNING);
        ptys[0]!.exit(1);

        const next = spawn('agent-tail');
        next.emit('PS C:\\work> claude --resume abc\r\n');
        expect(confirms()).toBe(1);

        next.emit(WARNING);
        expect(confirms()).toBe(2);
    });

    it('answers it again when the agent was KILLED and relaunched (the restart tool)', () => {
        spawn('agent-kill').emit(WARNING);
        killTerminalById('agent-kill');

        spawn('agent-kill').emit(WARNING);

        expect(confirms()).toBe(2);
    });
});
