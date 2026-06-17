import { describe, expect, it, vi, beforeEach } from 'vitest';

// Supervisor-level test for the Restart respawn fix (alpha.71). A running
// process that's restarted must, on its old pty's exit, spawn a FRESH pty —
// not bounce infinitely through startProcess→restartProcess→kill(throws)→…
// because the status was left 'running'. We mock the module boundaries
// (electron, fancy-term-host, db, adapters) and assert create() is called
// again after the restart exit.

const created: string[] = [];
const killed: string[] = [];
let killThrows = false;

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('@particle-academy/fancy-term-host', () => ({
    terminalManager: () => ({
        create: (opts: { id: string }) => {
            created.push(opts.id);
            return { id: opts.id, pid: 1, shell: 'bash' };
        },
        kill: (id: string) => {
            killed.push(id);
            if (killThrows) throw new Error('no such pty');
            return true;
        },
    }),
    resolveDefaultShell: () => ({ command: '/usr/bin/bash', args: [] }),
}));
vi.mock('../../db', () => ({
    getAllSettings: () => ({ cli_tools_in_terminals: 'off' }),
    getTerminalSpec: (id: string) => ({
        id,
        type: 'process',
        cwd: '/ws',
        shell: '/usr/bin/bash',
        meta: { command: 'npm run dev', restart_on_exit: true },
    }),
    listTerminalSpecs: () => [],
}));
vi.mock('../genie-adapter', () => ({ dbSettingsProvider: () => ({}) }));
vi.mock('../cli/tynn-cli', () => ({ buildTynnCliEnv: () => ({}) }));

import {
    startProcess,
    restartProcess,
    onProcessPtyExit,
    getProcessStatuses,
} from '../process-supervisor';

beforeEach(() => {
    created.length = 0;
    killed.length = 0;
    killThrows = false;
});

describe('process restart respawn', () => {
    it('a Restart of a running process spawns a fresh pty on the old pty exit', () => {
        startProcess('p1');
        expect(created).toEqual(['p1']); // initial spawn
        expect(getProcessStatuses().p1).toBe('running');

        // User clicks Restart: kills the live pty, arms restartRequested.
        restartProcess('p1');
        expect(killed).toEqual(['p1']);

        // The old pty's exit lands → should spawn ONE fresh pty (not loop).
        created.length = 0;
        onProcessPtyExit('p1', { exitCode: 0 });
        expect(created).toEqual(['p1']); // respawned exactly once
        expect(getProcessStatuses().p1).toBe('running');
    });

    it('does not re-bounce: the restart exit branch leaves status running after one spawn', () => {
        startProcess('p2');
        restartProcess('p2');
        created.length = 0;
        onProcessPtyExit('p2', { exitCode: 0 });
        // Exactly one fresh spawn — the old bug spawned zero (infinite bounce).
        expect(created).toEqual(['p2']);
    });
});
