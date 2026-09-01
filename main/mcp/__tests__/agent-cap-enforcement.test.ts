import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The agent-terminal cap (Tynn #117), exercised where an agent actually meets it:
 * the `runAgent` / `manageTerminals` MCP tools.
 *
 * The pure decision is covered elsewhere (terminal/__tests__/agent-cap.test.ts).
 * This file exists because "the resolver returned allowed:false" is much weaker
 * evidence than "the tool refused AND no terminal came into being" — for a
 * feature whose whole job is to say no, the thing worth pinning is the refusal
 * landing, not the boolean.
 *
 * REAL: the SQLite database (better-sqlite3, real migrations, real workspace and
 * terminal_spec rows), the real settings/override readers, the real live-pty
 * counting query, the real decision, and the real MCP tool handlers.
 *
 * FAKED: exactly two things — the pty spawn (`node-pty`, so no shell is really
 * started) and the approval modal (`forceQuestion`, which would otherwise block
 * on a human). Both are the process boundary, not the logic. Nothing that
 * decides or counts is mocked: a test that fakes the counting would pass against
 * a cap that does not work, and mocked backends have shipped broken behaviour in
 * this repo before.
 */

// --- FAKE 1: the pty process ------------------------------------------------
// A spawn that starts no shell but is otherwise a real participant: the manager
// registers it, `isLive` reports it, and `exit()` drives the manager's own exit
// path — which is how a slot gets freed when an agent finishes.
interface FakePty {
    pid: number;
    process: string;
    killed: boolean;
    /** Fire the manager's onExit handler, as a real pty does when it dies. */
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
            pid: 1000 + spawnedPtys.length,
            process: 'fake-shell',
            killed: false,
            onData: () => {},
            onExit: (cb) => {
                onExit = cb;
            },
            write: () => {},
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

// --- FAKE 2: the approval modal ---------------------------------------------
// Records every modal raised so a test can assert on the ORDER of the gates: the
// cap is checked first precisely so the user is never asked to approve a spawn
// that is already doomed. Always answers "Approve", so an approval is never the
// reason a spawn in this file failed.
const modalsRaised: string[] = [];

vi.mock('../../ask/force-question', () => ({
    forceQuestion: async (questions: Array<{ question: string }>) => {
        modalsRaised.push(questions[0]?.question ?? '');
        return { cancelled: false, answers: [{ selected: ['Approve'] }] };
    },
}));

// host-tools' import graph reaches main/tray.ts, which imports background.ts and
// runs the Electron app bootstrap at MODULE LOAD. Cutting the chain here keeps
// the test about the cap (same reason as manage-process-schedule.test.ts).
vi.mock('../../tray', () => ({
    rebuildMenu: vi.fn(),
    createTray: vi.fn(),
    setInboxBadge: vi.fn(),
    setUpdateAvailable: vi.fn(),
}));

import { app } from 'electron';
import {
    addWorkspace,
    getWorkspace,
    createTerminalSpec,
    deleteWorkspaceAgent,
    deleteTerminalSpec,
    getTerminalSpec,
    initDatabase,
    listTerminalSpecs,
    listWorkspaceAgents,
    setSettings,
    setWorkspaceAgentCap,
} from '../../db';
import {
    manageTerminalsForMcp,
    manageWorkspacesForMcp,
    registerAgentForMcp,
    startRegisteredAgent,
    runAgentForMcp,
} from '../host-tools';
import { terminalManager } from '@particle-academy/fancy-term-host';

// A real database + a real workspace directory on disk. `initDatabase` takes a
// DIRECTORY (it opens `genie.db` inside it), so a temp dir is how this suite
// gets a real, disposable SQLite file — the same shape every other db-backed
// test here uses.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-agent-cap-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });

// Keep any incidental snapshot-store writes (killTerminalById deletes a
// snapshot) inside the temp tree rather than the stub's fixed '/tmp'.
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const WS_ID = 'ws-cap';
const CALLER_ID = 'term-caller';
const OS_AGENT_ID = 'genie-os-agent';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Cap Demo',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Cap Demo',
    shape: 'simple',
    path: wsDir,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

addWorkspace({
    id: 'ws-other',
    backend: 'tynn',
    project_id: 'ws-other',
    project_name: 'Other Project',
    tynn_project_id: 'ws-other',
    tynn_project_name: 'Other Project',
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
 * The workspace's terminals that are actually RUNNING something.
 *
 * Deliberately NOT a re-implementation of `countAgentTerminals` — a test oracle
 * that copies the rule under test agrees with it even when the rule is wrong.
 * This is the independent question "what exists and is alive here", and the only
 * live terminals in this file are the ones the tools spawned (the caller's spec
 * has no pty).
 */
function liveTerminals(): string[] {
    const mgr = terminalManager();
    return listTerminalSpecs()
        .filter((s) => s.workspace_id === WS_ID && mgr.isLive(s.id))
        .map((s) => s.id);
}

/** Everything the world should look like when a spawn is REFUSED. */
function worldState(): { specs: number; ptys: number; live: number } {
    return {
        specs: listTerminalSpecs().length,
        ptys: spawnedPtys.length,
        live: liveTerminals().length,
    };
}

/**
 * A distinct saved-agent name per spawn.
 *
 * An agent is saved workspace configuration now (Tynn #254), so `runAgent start`
 * under a name the workspace already has REATTACHES rather than spawning — which
 * would make "fill the workspace to N agents" fill it to one. Every spawn here
 * is therefore a genuinely NEW agent, which is also what the cap is about: N
 * distinct model sessions competing for the owner's attention.
 */
let nextAgentName = 0;

/** Register, then start, a distinct agent through the real MCP handlers. */
async function startAgent(): Promise<{
    ok: boolean;
    id?: string;
    error?: string;
    pty?: FakePty;
}> {
    const before = spawnedPtys.length;
    // An explicit command so the test never depends on a `claude` binary being
    // installed; nothing runs it — it is written into the fake pty.
    const name = `agent-${++nextAgentName}`;
    const registered = await registerAgentForMcp(CALLER_ID, {
        name,
        purpose: `Agent cap test ${name}`,
        agent: 'claude',
    });
    if (!registered.ok) return registered;
    const res = await runAgentForMcp(CALLER_ID, {
        action: 'start',
        agent: 'claude',
        name,
        command: 'echo agent',
    });
    return {
        ok: res.ok,
        ...('id' in res && res.id ? { id: res.id } : {}),
        ...('error' in res && res.error ? { error: res.error } : {}),
        ...(spawnedPtys.length > before ? { pty: spawnedPtys[spawnedPtys.length - 1] } : {}),
    };
}

/** `manageTerminals create` through the real MCP handler. */
async function createTerminal(label = 'agent shell') {
    return manageTerminalsForMcp(CALLER_ID, { action: 'create', label });
}

/** Fill the workspace to `n` live agent terminals through the real tool path. */
async function fillToLimit(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const r = await startAgent();
        expect(r.ok).toBe(true);
        ids.push(r.id!);
    }
    expect(liveTerminals()).toHaveLength(n);
    return ids;
}

beforeEach(() => {
    terminalManager().killAll();
    for (const s of listTerminalSpecs()) deleteTerminalSpec(s.id);
    for (const agent of listWorkspaceAgents(WS_ID)) {
        deleteWorkspaceAgent(agent.id);
    }
    spawnedPtys.length = 0;
    modalsRaised.length = 0;

    // Workstation default of 2 — small enough to reach in a test, and a number
    // the message must name back.
    setSettings({ max_agent_terminals: '2' });
    setWorkspaceAgentCap(WS_ID, null); // inherit

    // The calling agent's own terminal. No agent_id and no created_by, so it is
    // not itself counted — the count under test is only the terminals spawned
    // through the tools below.
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
        /* best-effort — a locked sqlite file must not fail the run */
    }
});

describe('the built-in Genie OS agent capability boundary', () => {
    it('can discover workspaces but cannot use generic project terminal operations', async () => {
        deleteTerminalSpec(CALLER_ID);
        createTerminalSpec({
            id: OS_AGENT_ID,
            workspace_id: null,
            label: 'Genie',
            cwd: tmpRoot,
            type: 'terminal',
            meta: { agent_id: 'genie:workstation', agent: 'genie' },
        });

        const listed = await manageWorkspacesForMcp(OS_AGENT_ID, { action: 'list' });
        expect(listed.ok).toBe(true);
        expect(listed.workspaces).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: WS_ID, relation: 'operator' }),
                expect.objectContaining({ id: 'ws-other', relation: 'operator' }),
            ]),
        );

        const terminalAttempt = await manageTerminalsForMcp(OS_AGENT_ID, {
            action: 'list',
            workspaceId: WS_ID,
        });
        expect(terminalAttempt.ok).toBe(false);
        expect(terminalAttempt.error).toMatch(/no authority/i);
    });

    it('may launch only the saved agent configuration, never project command overrides', async () => {
        deleteTerminalSpec(CALLER_ID);
        createTerminalSpec({
            id: OS_AGENT_ID,
            workspace_id: null,
            label: 'Genie',
            cwd: tmpRoot,
            type: 'terminal',
            meta: { agent_id: 'genie:workstation', agent: 'genie' },
        });
        const registered = await registerAgentForMcp(OS_AGENT_ID, {
            workspaceId: WS_ID,
            name: 'safe-launch',
            purpose: 'A saved project agent',
            agent: 'claude',
        });
        expect(registered.ok).toBe(true);

        const attempted = await runAgentForMcp(OS_AGENT_ID, {
            action: 'start',
            workspaceId: WS_ID,
            name: 'safe-launch',
            command: 'echo arbitrary-project-command',
        });
        expect(attempted.ok).toBe(false);
        expect(attempted.error).toMatch(/saved configuration/i);
        expect(spawnedPtys).toHaveLength(0);
    });
});

describe('runAgent start, under the limit', () => {
    it('spawns a real agent terminal', async () => {
        const r = await startAgent();
        expect(r.ok).toBe(true);
        expect(r.id).toBeTruthy();

        // The terminal EXISTS in every sense the cap cares about: a persisted
        // spec that marks it as running an agent, and a live pty.
        const spec = getTerminalSpec(r.id!);
        expect(spec?.workspace_id).toBe(WS_ID);
        expect(spec?.meta?.agent).toBe('claude');
        expect(spec?.meta?.agent_id).toBeTruthy();
        expect(terminalManager().isLive(r.id!)).toBe(true);
        expect(liveTerminals()).toEqual([r.id]);

        // POSITIVE CONTROL for the "no modal on refusal" assertions below: the
        // approval gate really is on this path and really did fire here.
        expect(modalsRaised).toHaveLength(1);
        expect(modalsRaised[0]).toContain('LAUNCH a claude coding agent');
    });
});

describe('runAgent start, at the limit', () => {
    it('is refused, and NO terminal is created', async () => {
        await fillToLimit(2);
        const before = worldState();

        const r = await startAgent();

        expect(r.ok).toBe(false);
        // The refusal that matters is the one with nothing behind it. A tool that
        // answered ok:false but still spawned would be the worst outcome here, so
        // the absence is asserted three ways: no spec row, no pty, no live count.
        expect(worldState()).toEqual(before);
        expect(r.pty).toBeUndefined();
    });

    it('refuses BEFORE raising the approval modal', async () => {
        await fillToLimit(2);
        modalsRaised.length = 0;

        const r = await startAgent();

        expect(r.ok).toBe(false);
        // Asking someone to approve a spawn that is already refused spends their
        // attention on nothing — and attention is what the cap protects.
        expect(modalsRaised).toEqual([]);
    });

    it('names the limit, the count, and where it is set — and that the agent cannot raise it', async () => {
        await fillToLimit(2);

        const r = await startAgent();

        expect(r.ok).toBe(false);
        expect(r.error).toContain('limit of 2 agent terminals');
        expect(r.error).toContain('(2 running)');
        expect(r.error).toContain('the workstation default');
        expect(r.error).toMatch(/cannot raise it yourself/i);
        expect(r.error).toMatch(/only the person at this machine/i);
    });
});

describe('manageTerminals create', () => {
    it('spawns a plain agent-opened terminal, and it CONSUMES a slot', async () => {
        setWorkspaceAgentCap(WS_ID, 1);

        const r = await createTerminal();
        expect(r.ok).toBe(true);
        const spec = getTerminalSpec(r.affectedId!);
        // No agent runs in it — `created_by` is the only thing that makes it
        // countable. Without that stamp this surface would be an unbounded side
        // door around the cap, which is why the slot is asserted, not the stamp.
        expect(spec?.meta?.agent_id).toBeUndefined();
        expect(spec?.meta?.created_by).toBe('agent');
        expect(liveTerminals()).toEqual([r.affectedId]);

        // That single plain shell is the workspace's whole allowance: the next
        // spawn of EITHER kind is refused.
        expect((await createTerminal()).ok).toBe(false);
        expect((await startAgent()).ok).toBe(false);
    });

    it('is refused at the limit, with no terminal created and no modal raised', async () => {
        await fillToLimit(2);
        const before = worldState();
        modalsRaised.length = 0;

        const r = await createTerminal();

        expect(r.ok).toBe(false);
        expect(r.error).toContain('limit of 2 agent terminals');
        expect(r.error).toMatch(/cannot raise it yourself/i);
        expect(worldState()).toEqual(before);
        expect(modalsRaised).toEqual([]);
    });

    it('counts terminals from BOTH surfaces against the same limit', async () => {
        // One of each, then a third of either kind is refused — the cap is per
        // workspace, not per tool.
        const created = await createTerminal();
        expect(created.ok).toBe(true);
        const started = await startAgent();
        expect(started.ok).toBe(true);
        expect(liveTerminals()).toHaveLength(2);

        expect((await startAgent()).ok).toBe(false);
        expect((await createTerminal()).ok).toBe(false);
    });
});

describe('a dead terminal frees a slot', () => {
    it('an agent whose pty EXITS makes room for the next one, while its spec remains', async () => {
        const ids = await fillToLimit(2);
        expect((await startAgent()).ok).toBe(false);

        // The agent finishes and its shell exits. Nothing deletes the row —
        // specs are deliberately retained so a terminal can be revived.
        const dying = spawnedPtys[0];
        dying.exit();

        expect(getTerminalSpec(ids[0])).toBeTruthy(); // the row is still there…
        expect(terminalManager().isLive(ids[0])).toBe(false); // …but nothing is running
        expect(liveTerminals()).toHaveLength(1);

        // …so the slot is genuinely free. Counting ROWS instead of live ptys
        // would make the cap a ratchet that only ever tightens, and this
        // workspace would never start another agent again.
        const next = await startAgent();
        expect(next.ok).toBe(true);
        expect(liveTerminals()).toHaveLength(2);
    });

    it('killing one through manageTerminals frees a slot too', async () => {
        const ids = await fillToLimit(2);
        expect((await startAgent()).ok).toBe(false);

        const killed = await manageTerminalsForMcp(CALLER_ID, { action: 'kill', id: ids[1] });
        expect(killed.ok).toBe(true);
        expect(terminalManager().isLive(ids[1])).toBe(false);

        const next = await startAgent();
        expect(next.ok).toBe(true);
    });
});

describe('a workspace override', () => {
    it('is honoured over the workstation default, and the message points at it', async () => {
        // The workstation would allow 2; this workspace allows 1.
        setWorkspaceAgentCap(WS_ID, 1);

        const first = await startAgent();
        expect(first.ok).toBe(true);

        const second = await startAgent();
        expect(second.ok).toBe(false);
        expect(second.error).toContain('limit of 1 agent terminal');
        // Singular, and pointed at the knob that actually applied — the
        // workstation default is NOT what refused this.
        expect(second.error).not.toContain('agent terminals');
        expect(second.error).toContain("this workspace's own limit");
        expect(second.error).not.toContain('the workstation default, set in Settings');
    });

    it('can also RAISE the limit above the workstation default', async () => {
        setWorkspaceAgentCap(WS_ID, 3);

        await fillToLimit(3); // 3 > the workstation's 2, so the override won
        expect((await startAgent()).ok).toBe(false);
    });

    it("'unlimited' means the tool never refuses", async () => {
        setWorkspaceAgentCap(WS_ID, 'unlimited');

        // Well past the workstation default of 2.
        await fillToLimit(5);
        const extra = await startAgent();
        expect(extra.ok).toBe(true);
    });
});

/**
 * A CLICK on a dormant agent goes through the SAME start path as the tool.
 *
 * The sidebar starts a registered agent via `startRegisteredAgent`, which is
 * literally the body `runAgent start` runs. Only the approval MODAL is skipped:
 * it gates an AGENT launching an agent, and a person clicking the square is the
 * approval — asking them to approve their own click is noise.
 *
 * Extracting a shared path is exactly the refactor that quietly drops a check on
 * one branch, so the human branch is asserted against the cap directly rather
 * than assumed to have inherited it.
 */
describe('a human-initiated start', () => {
    it('is refused at the agent-terminal limit, like any other start', async () => {
        setWorkspaceAgentCap(WS_ID, 1);
        await fillToLimit(1);
        const registered = await registerAgentForMcp(CALLER_ID, {
            name: 'clicked',
            purpose: 'started from the sidebar',
            agent: 'claude',
        });
        expect(registered.ok).toBe(true); // POSITIVE CONTROL: the agent exists

        const result = await startRegisteredAgent(
            getWorkspace(WS_ID)!,
            { action: 'start', name: 'clicked', command: 'echo agent' } as never,
            { humanInitiated: true },
        );

        expect(result.ok).toBe(false);
        expect(String(('error' in result && result.error) || '')).toMatch(/limit/i);
    });

    it('raises NO approval modal', async () => {
        setWorkspaceAgentCap(WS_ID, null);
        await registerAgentForMcp(CALLER_ID, {
            name: 'quiet',
            purpose: 'started from the sidebar',
            agent: 'claude',
        });
        modalsRaised.length = 0;

        const result = await startRegisteredAgent(
            getWorkspace(WS_ID)!,
            { action: 'start', name: 'quiet', command: 'echo agent' } as never,
            { humanInitiated: true },
        );

        // POSITIVE CONTROL: it really started. "No modal" is also true of a
        // start that failed before reaching one.
        expect(result.ok).toBe(true);
        expect(modalsRaised).toHaveLength(0);
    });
});
