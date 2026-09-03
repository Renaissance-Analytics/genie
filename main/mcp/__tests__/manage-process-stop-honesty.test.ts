import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';

/**
 * "Never report a success you have not verified" (CONTRIBUTING.md), at
 * `manageProcess stop` — the same shape #368 fixed in `restartProcess`, one
 * function over.
 *
 * ```ts
 * try { terminalManager().kill(specId); }
 * catch { /* no live pty — fine *\/ }
 * setStatus(specId, 'stopped');
 * ```
 *
 * `kill(id): boolean` RETURNS FALSE for a missing pty — it does not throw. So
 * that `catch` could never fire, the boolean was discarded, and `'stopped'` was
 * written whatever happened.
 *
 * And a `true` is not much better on its own: both backends delete their record
 * and return `true` the moment a kill is REQUESTED — the host client's `kill()`
 * is literally `this.send({kind:'kill', id})` over a socket to a detached
 * process. Which also means `isLive()` is false straight after any kill, so a
 * confirmation built on it would pass for every stop and prove nothing. The one
 * thing that reports an actual exit is the pty's EXIT EVENT, which is what makes
 * a process `'stopped'` (see onProcessPtyExit) — so that is what a stop waits
 * for before claiming anything.
 *
 * NOTE ON SCOPE: no user-visible symptom is known for this. The field report
 * that raised it (genie#373) was retracted by its author — the port that stayed
 * open belonged to a different project's healthy daemon on the same default
 * port. This is the honesty defect that was left standing in the code once that
 * was stripped away.
 *
 * REAL: the supervisor, the terminal manager, the status transitions, the exit
 * decision, and the MCP handler.
 * FAKED: the pty process, the spec store, and the approval modal.
 */

// --- FAKE 1: the pty process ------------------------------------------------
// `ignoresKill` is the fault under test: `kill()` is delivered, the manager
// reports success and forgets the pty — and the process does not exit, so no
// exit event ever lands. A fake whose kill() always dies cannot express this,
// which is why this file carries its own (#368 had to widen two mocks for the
// same reason).
interface FakePty {
    pid: number;
    process: string;
    written: string[];
    exitCbs: Array<(e: { exitCode: number; signal?: number }) => void>;
    dataCbs: Array<(d: string) => void>;
    exited: boolean;
    /** True → kill() is a no-op: the process survives the signal. */
    ignoresKill: boolean;
    die(code: number, says?: string): void;
    onData(cb: (d: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    write(d: string): void;
    resize(c: number, r: number): void;
    kill(): void;
}

const spawnedPtys: FakePty[] = [];
/** The NEXT spawned pty ignores kill() — set per test. */
let nextSpawnIgnoresKill = false;

vi.mock('node-pty', () => ({
    spawn: (): FakePty => {
        const ignores = nextSpawnIgnoresKill;
        const pty: FakePty = {
            pid: 7000 + spawnedPtys.length,
            process: 'fake-shell',
            written: [],
            exitCbs: [],
            dataCbs: [],
            exited: false,
            ignoresKill: ignores,
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
                if (this.ignoresKill) return; // survives the signal
                this.die(0);
            },
        };
        spawnedPtys.push(pty);
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
    workspaceProcessApproval: () => false,
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

// The pty fan-out ipc.ts installs — feedTerminalData -> recordProcessOutput and
// feedTerminalExit -> onProcessPtyExit, both direct passthroughs. Faking the pty
// means faking those edges too.
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

/** A short confirm window, so the suite does not wait out the product default. */
const SETTLE = { settleMs: 60 };

beforeEach(() => {
    terminalManager().killAll();
    specs.clear();
    spawnedPtys.length = 0;
    nextSpawnIgnoresKill = false;
    seedCaller();
});

afterAll(() => {
    terminalManager().killAll();
});

describe('manageProcess stop — a kill is a request, not an exit', () => {
    it('POSITIVE CONTROL: a process whose pty exits IS reported stopped', async () => {
        // Without this, every assertion below would pass against a stop path
        // that reports failure for everything.
        proc('p-ok', 'sleep 100');
        startProcess('p-ok');
        expect(getProcessStatuses()['p-ok']).toBe('running');

        const res = await manageProcessForMcp('term-1', { action: 'stop', id: 'p-ok' }, SETTLE);

        expect(res.ok).toBe(true);
        expect(res.error).toBeUndefined();
        expect(getProcessStatuses()['p-ok']).toBe('stopped');
        expect(spawnedPtys[0]!.exited).toBe(true);
    });

    it('POSITIVE CONTROL: a process that was never running is still reported stopped', async () => {
        // `kill()` returns FALSE here, and that is the RIGHT answer: there is no
        // pty, so the process is down. The absence establishes it — nothing was
        // killed and no exit event is coming. A fix that only trusts a `true`
        // would report failure for this and be just as wrong the other way.
        proc('p-idle', 'sleep 100');

        const res = await manageProcessForMcp('term-1', { action: 'stop', id: 'p-idle' }, SETTLE);

        expect(res.ok).toBe(true);
        expect(res.error).toBeUndefined();
        expect(getProcessStatuses()['p-idle']).toBe('stopped');
    });

    it('a pty that does NOT exit is not reported stopped', async () => {
        // The defect: the kill is delivered, the manager reports success and
        // forgets the pty — and the process is still there. Nothing observed it
        // exit, so nothing may claim it stopped.
        nextSpawnIgnoresKill = true;
        proc('p-stubborn', 'sleep 100');
        startProcess('p-stubborn');
        expect(getProcessStatuses()['p-stubborn']).toBe('running');

        const res = await manageProcessForMcp(
            'term-1',
            { action: 'stop', id: 'p-stubborn' },
            SETTLE,
        );

        expect(spawnedPtys[0]!.exited).toBe(false); // the fault really is present
        expect(res.ok).toBe(false);
        // …and the caller is told what is known and what would settle it, not
        // just handed a verdict.
        expect(res.error).toMatch(/not (?:been )?confirm|could not confirm|unconfirmed/i);
        expect(res.error).toMatch(/list/i);
        expect(getProcessStatuses()['p-stubborn']).not.toBe('stopped');
    });
});
