import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `runAgent start` on a SAVED agent REATTACHES — it does not mint a second one
 * (Tynn #254).
 *
 * This is the acceptance test for the whole story, and it is written at the tool
 * boundary on purpose. The complaint was never "the resolver returns the wrong
 * enum"; it was that calling the tool twice left the workspace holding two
 * strangers. So what is asserted is the WORLD after the second call — one spec,
 * one AgentInbox identity, one live pty — rather than the return value that
 * describes it.
 *
 * Every "there is no second agent" assertion carries a POSITIVE CONTROL: the
 * agent that survived is asserted LIVE. Absence passes trivially against a start
 * that failed outright, and a reattach that quietly attached to nothing would be
 * a worse bug than the duplicate it replaced.
 *
 * REAL: the SQLite database (real migrations, real workspace + terminal_spec
 * rows), the real spec store, the real saved-agent resolution, the real MCP tool
 * handler, and the real terminal manager's liveness.
 *
 * FAKED: the pty spawn (`node-pty`) and the approval modal — the two process
 * boundaries. Nothing that decides is mocked.
 */

// --- FAKE 1: the pty process ------------------------------------------------
interface FakePty {
    pid: number;
    process: string;
    killed: boolean;
    /** Everything written into this pty — the launch command lands here. */
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
            pid: 2000 + spawnedPtys.length,
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

// --- FAKE 2: the approval modal ---------------------------------------------
const modalsRaised: string[] = [];

vi.mock('../../ask/force-question', () => ({
    forceQuestion: async (questions: Array<{ question: string }>) => {
        modalsRaised.push(questions[0]?.question ?? '');
        return { cancelled: false, answers: [{ selected: ['Approve'] }] };
    },
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
    getTerminalSpec,
    initDatabase,
    listTerminalSpecs,
    setSettings,
    setWorkspaceAgentCap,
} from '../../db';
import { runAgentForMcp } from '../host-tools';
import { terminalManager } from '@particle-academy/fancy-term-host';
import type { RunAgentRequest, RunAgentResult } from '../protocol';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-saved-agents-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });

(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const WS_ID = 'ws-saved';
const CALLER_ID = 'term-caller';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Saved Agents',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Saved Agents',
    shape: 'simple',
    path: wsDir,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

/** Every AGENT spec in the workspace — the roster the complaint is about. */
function agentSpecs() {
    return listTerminalSpecs().filter((s) => s.workspace_id === WS_ID && s.meta?.agent);
}

/** The durable AgentInbox identities in the workspace. A second agent shows up
 *  here even if the caller reported the same terminal id. */
function agentIds(): string[] {
    return agentSpecs()
        .map((s) => s.meta?.agent_id as string | undefined)
        .filter((v): v is string => !!v);
}

function start(req: Partial<RunAgentRequest> = {}): Promise<RunAgentResult> {
    return runAgentForMcp(CALLER_ID, {
        action: 'start',
        // An explicit command so nothing depends on a `claude` binary existing.
        command: 'echo agent',
        ...req,
    } as RunAgentRequest);
}

beforeEach(() => {
    terminalManager().killAll();
    for (const s of listTerminalSpecs()) deleteTerminalSpec(s.id);
    spawnedPtys.length = 0;
    modalsRaised.length = 0;
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

afterAll(() => {
    terminalManager().killAll();
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

describe('creating a saved agent', () => {
    it('needs `create` — a bare start refuses instead of minting a stranger', async () => {
        const r = await start({ name: 'tynn' });

        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/create/i);
        // Nothing came into being, and the user was never asked to approve
        // something that was already refused.
        expect(agentSpecs()).toHaveLength(0);
        expect(spawnedPtys).toHaveLength(0);
        expect(modalsRaised).toEqual([]);
    });

    it('creates one saved agent, with its provider and name on the record', async () => {
        const r = await start({ name: 'tynn', agent: 'claude', create: true });

        expect(r.ok).toBe(true);
        expect(r.id).toBeTruthy();
        expect(r.reattached).toBe(false);
        // The canonical machine-facing identity, provider first.
        expect(r.ref).toMatch(/^claude:tynn:/);

        const spec = getTerminalSpec(r.id!);
        expect(spec?.meta?.agent).toBe('claude');
        expect(spec?.meta?.whisper_purpose).toBe('tynn');
        expect(spec?.meta?.agent_id).toBeTruthy();
        expect(terminalManager().isLive(r.id!)).toBe(true);
    });

    it('refuses a second agent under a name the workspace already has', async () => {
        const first = await start({ name: 'tynn', agent: 'claude', create: true });
        expect(first.ok).toBe(true);

        const second = await start({ name: 'tynn', agent: 'claude', create: true });

        expect(second.ok).toBe(false);
        expect(second.error).toContain('claude:tynn');
        expect(agentSpecs()).toHaveLength(1);
        // POSITIVE CONTROL — the one that exists is genuinely running.
        expect(terminalManager().isLive(first.id!)).toBe(true);
    });
});

describe('runAgent start on a SAVED agent', () => {
    it('REATTACHES to the live agent instead of creating a second one', async () => {
        const created = await start({ name: 'tynn', agent: 'claude', create: true });
        expect(created.ok).toBe(true);
        const ptysAfterCreate = spawnedPtys.length;

        const again = await start({ name: 'tynn' });

        expect(again.ok).toBe(true);
        expect(again.reattached).toBe(true);
        // The SAME agent, by every identity that matters.
        expect(again.id).toBe(created.id);
        expect(again.ref).toBe(created.ref);
        expect(agentSpecs()).toHaveLength(1);
        expect(agentIds()).toHaveLength(1);
        // No second pty, and — the positive control — the first is still alive.
        expect(spawnedPtys).toHaveLength(ptysAfterCreate);
        expect(terminalManager().isLive(created.id!)).toBe(true);
    });

    it('does not re-launch the TUI into a terminal that is already running one', async () => {
        // The launch is submitted on a settle timer, so the writes are only
        // observable once the timers run.
        vi.useFakeTimers();
        try {
            const created = await start({ name: 'tynn', agent: 'claude', create: true });
            vi.runAllTimers();
            const pty = spawnedPtys[spawnedPtys.length - 1]!;
            const writesAfterLaunch = pty.written.length;
            expect(writesAfterLaunch).toBeGreaterThan(0); // POSITIVE CONTROL: it did launch

            await start({ name: 'tynn' });
            vi.runAllTimers();

            // Not vacuous: "the first pty got no new writes" is also true of a
            // start that spawned a SECOND pty and typed into that one instead,
            // which is the bug this story exists to remove. So the reattach is
            // pinned first, and the quiet pty second.
            expect(spawnedPtys).toHaveLength(1);
            expect(agentSpecs()).toHaveLength(1);
            // Typing the launch command into a live TUI's prompt is the visible
            // form of this bug — it appears as text in the running agent's input.
            expect(pty.written).toHaveLength(writesAfterLaunch);
            expect(terminalManager().isLive(created.id!)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('REVIVES a saved agent whose pty exited — same record, no second agent', async () => {
        const created = await start({ name: 'tynn', agent: 'claude', create: true });
        const agentIdBefore = getTerminalSpec(created.id!)?.meta?.agent_id;
        expect(agentIdBefore).toBeTruthy();

        // The agent finishes and its shell exits. The spec is retained.
        spawnedPtys[spawnedPtys.length - 1]!.exit();
        expect(terminalManager().isLive(created.id!)).toBe(false);

        const revived = await start({ name: 'tynn' });

        expect(revived.ok).toBe(true);
        expect(revived.reattached).toBe(true);
        expect(revived.id).toBe(created.id);
        // One record, one durable identity — a revive is not a new agent, which
        // is what keeps its inbox, channels and DM history attached.
        expect(agentSpecs()).toHaveLength(1);
        expect(getTerminalSpec(created.id!)?.meta?.agent_id).toBe(agentIdBefore);
        // POSITIVE CONTROL: it is actually running again, not merely "not duplicated".
        expect(terminalManager().isLive(created.id!)).toBe(true);
    });

    it('keeps two providers under the same name distinct', async () => {
        const claude = await start({ name: 'tynn', agent: 'claude', create: true });
        const codex = await start({ name: 'tynn', agent: 'codex', create: true });
        expect(claude.ok && codex.ok).toBe(true);
        expect(claude.id).not.toBe(codex.id);

        // A name alone is now ambiguous — answering with either would silently
        // attach the caller to an agent it did not ask for.
        const ambiguous = await start({ name: 'tynn' });
        expect(ambiguous.ok).toBe(false);
        expect(ambiguous.error).toContain('claude:tynn');
        expect(ambiguous.error).toContain('codex:tynn');

        // Named with its provider, each reattaches to its own.
        expect((await start({ name: 'tynn', agent: 'codex' })).id).toBe(codex.id);
        expect((await start({ name: 'tynn', agent: 'claude' })).id).toBe(claude.id);
        expect(agentSpecs()).toHaveLength(2);
    });
});

describe('listing the workspace roster', () => {
    it('reports every saved agent by its canonical ref, and never invents one', async () => {
        await start({ name: 'tynn', agent: 'claude', create: true });
        await start({ name: 'tynn-slave', agent: 'codex', create: true });

        const listed = await runAgentForMcp(CALLER_ID, { action: 'list' });

        expect(listed.ok).toBe(true);
        expect(listed.agents?.map((a) => `${a.provider}:${a.name}`).sort()).toEqual([
            'claude:tynn',
            'codex:tynn-slave',
        ]);
        // A read-only action creates nothing and asks nobody.
        expect(agentSpecs()).toHaveLength(2);
        expect(modalsRaised.filter((m) => m.includes('LAUNCH'))).toHaveLength(2);
    });
});
