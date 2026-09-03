import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * "Never report a success you have not verified" (CONTRIBUTING.md), at the two
 * MCP tools that put text into a pty: `manageTerminals write` and `runAgent
 * send`.
 *
 * Both delegate to `deliverTerminalInput`, which returned `Promise<void>` and
 * threw away BOTH `writeToTerminal` booleans — so `ok: true` was produced by the
 * absence of a throw, and the pty being gone entirely read the same as a
 * delivered prompt.
 *
 * The outcome is THREE-valued, not two, because a multi-line submit is two
 * writes separated by `PASTE_SUBMIT_DELAY_MS`:
 *
 *   1. both land                     -> sent and submitted
 *   2. the BODY write fails          -> nothing was sent
 *   3. the body lands, the ENTER does NOT -> the text is sitting in the TUI's
 *      input box, unsubmitted, and will be sent by the next stray Enter
 *
 * Case 3 is the one a caller most needs told, and it is also the one that
 * collapsing into `ok: false` would misreport in the opposite direction
 * ("nothing was sent" when something was).
 *
 * REAL: the database and migrations, the spec store, the terminal manager, the
 * real `writeToTerminal` (and therefore the real "no pty for that id -> false"),
 * the real input resolution, and the real MCP tool handlers.
 * FAKED: the pty process and the approval modal — the two process boundaries.
 */

// --- FAKE 1: the pty process ------------------------------------------------
// A spawn that starts no shell but is a real participant: the manager registers
// it, and firing its onExit is how a pty stops existing as far as
// `terminalManager().write` is concerned — which is the ONLY way that call
// returns false. `dieOnWrite` makes that happen at an exact write, so case 3
// (body lands, Enter does not) is deterministic rather than a race with the
// 60ms paste delay.
interface FakePty {
    pid: number;
    process: string;
    killed: boolean;
    /** Every chunk that reached this pty, in order. */
    written: string[];
    /** Die (fire onExit) immediately after the Nth write, 1-based. 0 = never. */
    dieOnWrite: number;
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
            dieOnWrite: 0,
            onData: () => {},
            onExit: (cb) => {
                onExit = cb;
            },
            write(d: string) {
                this.written.push(d);
                if (this.dieOnWrite && this.written.length === this.dieOnWrite) {
                    this.killed = true;
                    onExit?.({ exitCode: 1 });
                }
            },
            resize: () => {},
            kill() {
                this.killed = true;
                onExit?.({ exitCode: 0 });
            },
        };
        spawnedPtys.push(pty);
        return pty;
    },
}));

// --- FAKE 2: the approval modal ---------------------------------------------
// Always approves, so an approval is never the reason a write in this file
// failed.
vi.mock('../../ask/force-question', () => ({
    forceQuestion: async () => ({ cancelled: false, answers: [{ selected: ['Approve'] }] }),
}));

// host-tools' import graph reaches main/tray.ts, which runs the Electron app
// bootstrap at MODULE LOAD. Cut the chain here (same reason as the cap suite).
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
    initDatabase,
    listTerminalSpecs,
} from '../../db';
import { manageTerminalsForMcp, runAgentForMcp } from '../host-tools';
import { terminalManager } from '@particle-academy/fancy-term-host';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-write-honesty-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });

(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const WS_ID = 'ws-write-honesty';
const CALLER_ID = 'term-write-caller';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Write Honesty',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Write Honesty',
    shape: 'simple',
    path: wsDir,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

/** A multi-line body — the shape that splits into body + a separate Enter. */
const MULTI = 'first line\nsecond line';

/** Create a terminal through the real tool and hand back its id + its fake pty. */
async function makeTarget(): Promise<{ id: string; pty: FakePty }> {
    const before = spawnedPtys.length;
    const r = await manageTerminalsForMcp(CALLER_ID, { action: 'create', label: 'target' });
    expect(r.ok).toBe(true);
    expect(spawnedPtys.length).toBeGreaterThan(before);
    const pty = spawnedPtys[spawnedPtys.length - 1]!;
    // The launch/shell settle may type into the pty; only the writes this test
    // makes should be counted, so start from a clean slate.
    pty.written.length = 0;
    return { id: r.affectedId!, pty };
}

beforeEach(() => {
    terminalManager().killAll();
    for (const s of listTerminalSpecs()) deleteTerminalSpec(s.id);
    spawnedPtys.length = 0;
    createTerminalSpec({
        id: CALLER_ID,
        workspace_id: WS_ID,
        label: 'caller',
        cwd: wsDir,
        type: 'terminal',
        meta: {},
    });
});

afterAll(() => {
    terminalManager().killAll();
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

describe('manageTerminals write — reports what reached the pty', () => {
    it('POSITIVE CONTROL: a live terminal gets body AND submit, and says both landed', async () => {
        // Without this, every assertion below would also pass against a write
        // path that refuses everything.
        const { id, pty } = await makeTarget();

        const r = await manageTerminalsForMcp(CALLER_ID, { action: 'write', id, data: MULTI });

        expect(r.ok).toBe(true);
        expect(r.delivered).toBe(true);
        expect(r.submitted).toBe(true);
        expect(r.error).toBeUndefined();
        // Two writes really happened, and the body is in the first one.
        expect(pty.written).toHaveLength(2);
        expect(pty.written[0]).toContain('first line');
        expect(pty.written[1]).toBe('\r');
    });

    it('a DEAD terminal is a failure, not an ok:true that sent nothing', async () => {
        const { id, pty } = await makeTarget();
        terminalManager().kill(id); // the pty is gone; the spec is not

        const r = await manageTerminalsForMcp(CALLER_ID, { action: 'write', id, data: MULTI });

        expect(r.ok).toBe(false);
        expect(r.delivered).toBe(false);
        expect(r.error).toMatch(/nothing was sent/i);
        expect(pty.written).toHaveLength(0);
    });

    it('body delivered but the submit lost: says so, and does NOT claim nothing was sent', async () => {
        const { id, pty } = await makeTarget();
        pty.dieOnWrite = 1; // survives the paste, gone before the Enter

        const r = await manageTerminalsForMcp(CALLER_ID, { action: 'write', id, data: MULTI });

        // The body DID land — reporting `ok: false` here would be the same class
        // of false report in the other direction.
        expect(r.delivered).toBe(true);
        expect(r.submitted).toBe(false);
        expect(pty.written).toHaveLength(1);
        expect(pty.written[0]).toContain('first line');
        // And the caller is told the actionable part: it is sitting there,
        // unsubmitted.
        expect(r.note).toMatch(/unsubmitted|not submitted/i);
    });

    it('a single-line submit is one write, and reports submitted on it', async () => {
        const { id, pty } = await makeTarget();

        const r = await manageTerminalsForMcp(CALLER_ID, { action: 'write', id, data: 'hi' });

        expect(r.ok).toBe(true);
        expect(r.delivered).toBe(true);
        expect(r.submitted).toBe(true);
        expect(pty.written).toEqual(['hi\r']);
    });
});

describe('runAgent send — the same three outcomes', () => {
    it('POSITIVE CONTROL: a live agent terminal is sent and submitted', async () => {
        const { id, pty } = await makeTarget();

        const r = await runAgentForMcp(CALLER_ID, { action: 'send', id, prompt: MULTI });

        expect(r.ok).toBe(true);
        expect(r.delivered).toBe(true);
        expect(r.submitted).toBe(true);
        expect(pty.written).toHaveLength(2);
    });

    it('a dead agent terminal fails instead of reporting a prompt that never arrived', async () => {
        const { id, pty } = await makeTarget();
        terminalManager().kill(id);

        const r = await runAgentForMcp(CALLER_ID, { action: 'send', id, prompt: MULTI });

        expect(r.ok).toBe(false);
        expect(r.delivered).toBe(false);
        expect(r.error).toMatch(/nothing was sent/i);
        expect(pty.written).toHaveLength(0);
    });

    it('a prompt left unsubmitted in the box is reported as exactly that', async () => {
        const { id, pty } = await makeTarget();
        pty.dieOnWrite = 1;

        const r = await runAgentForMcp(CALLER_ID, { action: 'send', id, prompt: MULTI });

        expect(r.delivered).toBe(true);
        expect(r.submitted).toBe(false);
        expect(r.note).toMatch(/unsubmitted|not submitted/i);
        expect(pty.written).toHaveLength(1);
    });
});
