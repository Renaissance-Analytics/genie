import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';

/**
 * "Never report a success you have not verified" (CONTRIBUTING.md), at
 * `manageProcess start` / `restart`.
 *
 * `startProcess` set `running` on the line AFTER `terminalManager().create()`,
 * so the status meant "the spawn call did not throw" — which a `command not
 * found` also does not, before exiting milliseconds later. The tool then
 * returned `ok: true` with that status attached.
 *
 * `restartProcess` never set a status at all, and its only no-pty recovery hung
 * off a `catch` that cannot fire: `terminalManager().kill()` RETURNS false for a
 * missing pty, it does not throw. So a restart against a stale `running` killed
 * nothing, waited for an exit event that was never coming, respawned nothing —
 * and reported success.
 *
 * REAL: the supervisor, the terminal manager, the status transitions, the exit
 * decision, the recorded output, and the MCP handler.
 * FAKED: the pty process, the spec store, and the approval modal.
 */

// --- FAKE 1: the pty process ------------------------------------------------
// `diesWith` reproduces a command that is not found: the shell starts, prints,
// and exits on the next tick. That is the whole defect — a spawn that succeeds
// and a process that does not survive it.
interface FakePty {
    pid: number;
    process: string;
    written: string[];
    /** Every registered exit listener — the manager's, plus the ipc.ts fan-out
     *  the test installs. A single-slot handler would silently replace one with
     *  the other. */
    exitCbs: Array<(e: { exitCode: number; signal?: number }) => void>;
    dataCbs: Array<(d: string) => void>;
    exited: boolean;
    die(code: number, says?: string): void;
    onData(cb: (d: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    write(d: string): void;
    resize(c: number, r: number): void;
    kill(): void;
}

const spawnedPtys: FakePty[] = [];
/** Exit code the NEXT spawned pty dies with on the next tick; null = it lives. */
let nextSpawnDiesWith: number | null = null;
/** Output the dying pty emits first — the evidence of WHY it died. */
let nextSpawnSays = '';

vi.mock('node-pty', () => ({
    spawn: (): FakePty => {
        const dies = nextSpawnDiesWith;
        const says = nextSpawnSays;
        const pty: FakePty = {
            pid: 7000 + spawnedPtys.length,
            process: 'fake-shell',
            written: [],
            exitCbs: [],
            dataCbs: [],
            exited: false,
            die(code: number, text?: string) {
                if (this.exited) return;
                this.exited = true;
                if (text) for (const cb of [...this.dataCbs]) cb(text);
                for (const cb of [...this.exitCbs]) cb({ exitCode: code });
            },
            onData(cb) {
                this.dataCbs.push(cb);
            },
            onExit(cb) {
                this.exitCbs.push(cb);
            },
            write(d: string) {
                this.written.push(d);
            },
            resize: () => {},
            kill() {
                this.die(0);
            },
        };
        spawnedPtys.push(pty);
        // A command that is not found: the shell starts, prints, and is gone on
        // the next tick — after `create()` has already returned successfully.
        if (dies !== null) setTimeout(() => pty.die(dies, says), 0);
        return pty;
    },
}));

// --- FAKE 2: the spec store + workspace -------------------------------------
type Spec = {
    id: string;
    workspace_id: string | null;
    label: string;
    cwd: string;
    type: string;
    shell?: string;
    enabled?: boolean;
    meta: Record<string, unknown>;
};

const specs = new Map<string, Spec>();
const WS = { id: 'ws-1', path: '/ws', project_name: 'Demo' };

vi.mock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
    app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', on: () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    shell: { openExternal: () => {} },
}));

vi.mock('../../db', () => ({
    listWorkspaces: () => [WS],
    getWorkspace: (id: string) => (id === WS.id ? WS : undefined),
    listTerminalSpecs: () => [...specs.values()],
    getTerminalSpec: (id: string) => specs.get(id) ?? null,
    createTerminalSpec: (input: Spec) => {
        const row = { enabled: true, ...input };
        specs.set(input.id, row);
        return row;
    },
    updateTerminalSpec: (id: string, patch: Partial<Spec>) => {
        const s = specs.get(id);
        if (!s) return null;
        Object.assign(s, patch);
        return s;
    },
    deleteTerminalSpec: (id: string) => specs.delete(id),
    workspaceProcessApproval: () => false, // never the reason a start failed here
    workspaceTerminalApproval: () => true,
    workspaceScheduleApproval: () => false,
    getAllSettings: () => ({}),
    getWorkspaceIssuewatchPolicyBuckets: () => ({}),
    removeWorkspace: () => {},
}));

vi.mock('../../terminal/genie-adapter', () => ({
    dbSettingsProvider: () => ({ get: () => undefined }),
}));

vi.mock('../../ask/force-question', () => ({
    forceQuestion: async () => ({ cancelled: false, answers: [{ selected: ['Approve'] }] }),
}));

vi.mock('../../terminal/process-scheduler', () => ({
    armSchedule: vi.fn(),
    disarmSchedule: vi.fn(),
    forgetSchedule: vi.fn(),
    runScheduleNow: vi.fn(),
    nextRunAt: () => null,
}));

vi.mock('../../terminal/ipc', () => ({
    broadcastTerminalSpecsChanged: vi.fn(),
    killTerminalById: vi.fn(),
    createAgentTerminal: vi.fn(),
    decideAgentTerminalSpawn: vi.fn(),
    writeToTerminal: vi.fn(),
    readTerminalOutput: vi.fn(() => ({ data: '', cursor: 0 })),
    agentSessionTranscriptExists: vi.fn(),
    isTerminalLive: vi.fn(),
}));

vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: [] }) }));
vi.mock('../../ipc', () => ({ broadcastWorkspacesChanged: vi.fn() }));
vi.mock('../../remote', () => ({ broadcastLocal: vi.fn() }));
vi.mock('../../mobile/server', () => ({ mobileEmit: vi.fn() }));
vi.mock('../../tray', () => ({
    rebuildMenu: vi.fn(),
    createTray: vi.fn(),
    setInboxBadge: vi.fn(),
    setUpdateAvailable: vi.fn(),
}));

import { manageProcessForMcp } from '../host-tools';
import {
    getProcessStatuses,
    onProcessPtyExit,
    recordProcessOutput,
    startProcess,
} from '../../terminal/process-supervisor';
import { terminalManager } from '@particle-academy/fancy-term-host';

// The pty fan-out ipc.ts installs — `feedTerminalData` -> recordProcessOutput
// and `feedTerminalExit` -> onProcessPtyExit, both direct passthroughs. Faking
// the pty means faking those edges too. Installed once at the create seam, so it
// covers restart respawns as well.
{
    const mgr = terminalManager() as unknown as {
        create: (o: { id: string; cwd: string; shell: string; args: string[] }) => unknown;
    };
    const realCreate = mgr.create.bind(mgr);
    mgr.create = (o) => {
        const r = realCreate(o);
        const pty = spawnedPtys[spawnedPtys.length - 1];
        pty?.dataCbs.push((d) => recordProcessOutput(o.id, d));
        pty?.exitCbs.push((e) => onProcessPtyExit(o.id, e));
        return r;
    };
}

function seedCaller(): void {
    specs.set('term-1', {
        id: 'term-1',
        workspace_id: WS.id,
        label: 'agent',
        cwd: '/ws',
        type: 'terminal',
        meta: {},
    });
}

function proc(id: string, command: string): void {
    specs.set(id, {
        id,
        workspace_id: WS.id,
        label: id,
        cwd: '/ws',
        type: 'process',
        shell: 'fake-shell',
        enabled: true,
        meta: { command, restart_on_exit: false },
    });
}

/** A short settle window, so the suite does not wait out the product default. */
const SETTLE = { settleMs: 60 };

beforeEach(() => {
    terminalManager().killAll();
    specs.clear();
    spawnedPtys.length = 0;
    nextSpawnDiesWith = null;
    nextSpawnSays = '';
    seedCaller();
});

afterAll(() => {
    terminalManager().killAll();
});

describe('manageProcess start — a spawn is not a run', () => {
    it('POSITIVE CONTROL: a process that survives is reported as started', async () => {
        // Without this, every assertion below would pass against a start path
        // that reports failure for everything.
        proc('p-ok', 'sleep 100');

        const res = await manageProcessForMcp('term-1', { action: 'start', id: 'p-ok' }, SETTLE);

        expect(res.ok).toBe(true);
        expect(res.pending).toBeFalsy();
        expect(getProcessStatuses()['p-ok']).toBe('running');
        expect(terminalManager().isLive('p-ok')).toBe(true);
    });

    it('a command that EXITS immediately is not reported as running', async () => {
        // The case the rule names: `create()` did not throw, so `running` was
        // set — and the shell was already gone.
        nextSpawnDiesWith = 127;
        nextSpawnSays = 'bash: nosuchcmd: command not found\n';
        proc('p-bad', 'nosuchcmd --now');

        const res = await manageProcessForMcp('term-1', { action: 'start', id: 'p-bad' }, SETTLE);

        expect(res.ok).toBe(false);
        // …and the caller is handed the evidence, not just a verdict.
        expect(res.error).toMatch(/exited|crashed/i);
        expect(res.error).toContain('command not found');
        expect(getProcessStatuses()['p-bad']).not.toBe('running');
    });
});

describe('manageProcess restart — kill() returning false is not a restart', () => {
    it('respawns when the pty is already gone instead of reporting a restart that never happened', async () => {
        proc('p-stale', 'sleep 100');
        startProcess('p-stale');
        expect(getProcessStatuses()['p-stale']).toBe('running');
        const spawnedBefore = spawnedPtys.length;

        // The pty vanishes WITHOUT the supervisor hearing about it — a missed
        // exit event, or a pty host that dropped it. Swallowing the exit is the
        // whole point: the status is left a stale `running`, which is the state
        // that made `kill()` return false and the restart do nothing.
        spawnedPtys[spawnedPtys.length - 1]!.exited = true; // no exit event escapes
        terminalManager().kill('p-stale');
        expect(terminalManager().isLive('p-stale')).toBe(false);
        expect(getProcessStatuses()['p-stale']).toBe('running');

        const res = await manageProcessForMcp(
            'term-1',
            { action: 'restart', id: 'p-stale' },
            SETTLE,
        );

        // A restart that reports success must have produced a live process.
        expect(spawnedPtys.length).toBeGreaterThan(spawnedBefore);
        expect(terminalManager().isLive('p-stale')).toBe(true);
        expect(res.ok).toBe(true);
    });

    it('POSITIVE CONTROL: a live process still restarts through the normal exit path', async () => {
        proc('p-live', 'sleep 100');
        startProcess('p-live');
        const spawnedBefore = spawnedPtys.length;

        const res = await manageProcessForMcp('term-1', { action: 'restart', id: 'p-live' }, SETTLE);

        expect(spawnedPtys.length).toBeGreaterThan(spawnedBefore);
        expect(res.ok).toBe(true);
        expect(getProcessStatuses()['p-live']).toBe('running');
    });
});
