import { describe, expect, it, vi, beforeEach } from 'vitest';

// Supervisor-level tests for the Restart respawn fix (alpha.71) and the
// was_running restore-on-launch behavior (alpha.72). We mock the module
// boundaries (electron, fancy-term-host, db, adapters); the db mock keeps a
// per-id spec store so updateTerminalSpec writes are reflected by
// getTerminalSpec, letting us assert the was_running persistence.

const created: string[] = [];
const killed: string[] = [];
let killThrows = false;

// Mutable spec store the db mock reads/writes. Each spec is a process with a
// command unless overridden by the test before calling the supervisor.
type Spec = { id: string; type: string; cwd: string; shell: string; enabled?: boolean; meta: Record<string, unknown> };
const specs = new Map<string, Spec>();
function seedSpec(id: string, meta: Record<string, unknown> = {}, enabled = true): void {
    specs.set(id, {
        id,
        type: 'process',
        cwd: '/ws',
        shell: '/usr/bin/bash',
        enabled,
        meta: { command: 'npm run dev', restart_on_exit: true, ...meta },
    });
}

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
    getTerminalSpec: (id: string) => specs.get(id) ?? null,
    listTerminalSpecs: () => [...specs.values()],
    updateTerminalSpec: (id: string, patch: { meta?: Record<string, unknown> }) => {
        const s = specs.get(id);
        if (s && patch.meta) s.meta = { ...patch.meta };
    },
}));
vi.mock('../genie-adapter', () => ({ dbSettingsProvider: () => ({}) }));
vi.mock('../cli/tynn-cli', () => ({ buildTynnCliEnv: () => ({}) }));

import {
    startProcess,
    restartProcess,
    stopProcess,
    onProcessPtyExit,
    startAutostartProcesses,
    getProcessStatuses,
} from '../process-supervisor';

beforeEach(() => {
    created.length = 0;
    killed.length = 0;
    killThrows = false;
    specs.clear();
    // The restart-respawn tests use ids p1/p2; seed them as process specs.
    seedSpec('p1');
    seedSpec('p2');
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

describe('process was_running persistence + restore', () => {
    it('persists was_running=true when a process starts running', () => {
        seedSpec('w1', { was_running: false });
        startProcess('w1');
        expect(specs.get('w1')!.meta.was_running).toBe(true);
    });

    it('clears was_running on a deliberate stop', () => {
        seedSpec('w2', { was_running: true });
        startProcess('w2'); // running → was_running true
        stopProcess('w2');
        expect(specs.get('w2')!.meta.was_running).toBe(false);
    });

    it('keeps was_running on a non-deliberate crash (so a recoverable process still restores)', () => {
        // restart_on_exit=false → a non-zero exit is 'crashed' (not the
        // deliberate-stop or terminal-'failed' path), so the intent is kept.
        seedSpec('w3', { was_running: false, restart_on_exit: false });
        startProcess('w3');
        expect(specs.get('w3')!.meta.was_running).toBe(true);
        onProcessPtyExit('w3', { exitCode: 1 });
        expect(getProcessStatuses().w3).toBe('crashed');
        expect(specs.get('w3')!.meta.was_running).toBe(true);
    });

    it('restores was_running processes on launch (alongside autostart), skips stopped ones', () => {
        specs.clear();
        seedSpec('boot-run', { was_running: true });
        seedSpec('boot-auto', { autostart: true });
        seedSpec('boot-stopped', { was_running: false });
        seedSpec('boot-disabled', { was_running: true }, false);
        startAutostartProcesses();
        expect(created.sort()).toEqual(['boot-auto', 'boot-run']);
        expect(created).not.toContain('boot-stopped');
        expect(created).not.toContain('boot-disabled');
    });
});
