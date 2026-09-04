import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `runAgent diagnose` against a REAL workstation — the acceptance test.
 *
 * `agents/triage.test.ts` proves the reasoning. This proves the GATHERING, which
 * is where the interesting way to be wrong lives: an AMS agent has a
 * `workspace_agents.id`, and the terminal it runs in carries a SEPARATE
 * `meta.agent_id` minted per terminal. `ready_at` and `transport_verified_at`
 * hang off the first; the AgentInbox broker and the harness-transport registry
 * are keyed on the second. Read one id for both and every healthy agent on the
 * machine is reported unreachable — a triage tool that is confidently wrong,
 * which is worse than none.
 *
 * So the load-bearing test here is the HEALTHY one. It can only pass if both
 * lookups used the right id, and every "it detects a fault" case below is only
 * meaningful because it does.
 *
 * The stale-binding case is the one that justifies the tool existing at all:
 * NOTHING is changed except the in-memory registry, and the diagnosis flips from
 * healthy to wedged. No single surface could report that — the database still
 * says the transport verified, because it did, in a Genie run that is over.
 *
 * REAL: the SQLite database and its migrations, the agent + runtime rows, the
 * terminal specs, the AgentInbox broker, the harness-transport registry, the
 * terminal manager's liveness, and the MCP tool handler.
 * FAKED: the pty process and the approval modal — the two process boundaries.
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
            pid: 4000 + spawnedPtys.length,
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
    getDb,
    getTerminalSpec,
    initDatabase,
    listTerminalSpecs,
    listWorkspaceAgents,
    markWorkspaceAgentReadyByTerminal,
    markWorkspaceAgentTransportState,
    setSettings,
    setWorkspaceAgentCap,
    updateTerminalSpec,
} from '../../db';
import { registerAgentForMcp, runAgentForMcp } from '../host-tools';
import { agentInboxBroker } from '../../agentinbox/broker';
import { harnessTransportRegistry } from '../../agentinbox/harness-transport';
import { terminalManager } from '@particle-academy/fancy-term-host';
import type { AgentDiagnosis } from '../../agents/triage';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-diagnose-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });

(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const WS_ID = 'ws-diagnose';
const CALLER_ID = 'term-diagnose-caller';
const AGENT_NAME = 'tynn-builder';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Diagnose',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Diagnose',
    shape: 'simple',
    path: wsDir,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

async function registerAgent(name = AGENT_NAME): Promise<void> {
    const registered = await registerAgentForMcp(CALLER_ID, {
        name,
        purpose: `Test agent ${name}`,
        agent: 'claude',
    });
    if (!registered.ok) throw new Error(`fixture failed to register: ${registered.error}`);
}

async function startAgent(name = AGENT_NAME): Promise<string> {
    const started = await runAgentForMcp(CALLER_ID, {
        action: 'start',
        name,
        // An explicit command so nothing depends on a `claude` binary existing.
        command: 'echo agent',
    });
    if (!started.ok || !started.id) throw new Error(`fixture failed to start: ${started.error}`);
    return started.id;
}

/** The terminal's AgentInbox identity — NOT the same id as the agent record's. */
function inboxIdOf(specId: string): string {
    const id = getTerminalSpec(specId)?.meta?.agent_id;
    if (typeof id !== 'string') throw new Error('fixture: the spec has no AgentInbox identity');
    return id;
}

function agentRowId(name = AGENT_NAME): string {
    const row = listWorkspaceAgents(WS_ID).find((a) => a.name === name);
    if (!row) throw new Error('fixture: no agent record');
    return row.id;
}

/**
 * Put one agent into the state a fully-booted one is actually in: transport
 * verified in the DB, bound in the registry, joined to the inbox, boot reported.
 */
async function bootedAgent(): Promise<{ specId: string; inboxId: string; agentId: string }> {
    await registerAgent();
    const specId = await startAgent();
    const inboxId = inboxIdOf(specId);
    const agentId = agentRowId();
    markWorkspaceAgentTransportState(getDb(), agentId, 'claude-channel', { ok: true });
    markWorkspaceAgentReadyByTerminal(getDb(), specId);
    harnessTransportRegistry.bindPull(inboxId, 'claude-channel');
    return { specId, inboxId, agentId };
}

async function diagnose(req: { name?: string; id?: string } = {}): Promise<{
    diagnoses: AgentDiagnosis[];
    note: string;
}> {
    const result = await runAgentForMcp(CALLER_ID, { action: 'diagnose', ...req });
    expect(result.ok).toBe(true);
    return { diagnoses: result.diagnoses ?? [], note: result.note ?? '' };
}

const only = (list: AgentDiagnosis[]): AgentDiagnosis => {
    expect(list).toHaveLength(1);
    return list[0]!;
};

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

afterAll(() => {
    terminalManager().killAll();
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

describe('a fully booted agent', () => {
    it('is reported healthy — which is only possible if BOTH ids were read right', () => {
        // ★ THE CONTROL. `transportBoundNow` is looked up in the registry by the
        // TERMINAL's `meta.agent_id`; `transport_verified_at` comes off the AGENT
        // RECORD by its own id. Cross them and this agent — which is genuinely
        // fine — comes back wedged with two faults it does not have.
        return bootedAgent().then(async () => {
            const d = only((await diagnose()).diagnoses);

            expect(d.condition).toBe('healthy');
            expect(d.findings).toEqual([]);
            expect(d.name).toBe(AGENT_NAME);
        });
    });

    it('summarises the sweep in one line', async () => {
        await bootedAgent();

        const { note } = await diagnose();

        expect(note).toMatch(/1 agent/);
        expect(note).toMatch(/1 healthy/);
    });
});

describe('a transport binding that did not survive a Genie restart', () => {
    it('is wedged, and the diagnosis says the database and memory disagree', async () => {
        const { inboxId } = await bootedAgent();
        expect(only((await diagnose()).diagnoses).condition).toBe('healthy');

        // The ONLY change: the in-memory binding is gone, exactly as it would be
        // after Genie restarts. Every durable record still says verified.
        harnessTransportRegistry.unbind(inboxId);

        const d = only((await diagnose()).diagnoses);
        expect(d.condition).toBe('wedged');
        expect(d.findings[0]?.ailment).toBe('transport-binding-lost');
        expect(d.findings[0]?.detail).toMatch(/earlier Genie run/i);
        expect(d.findings[0]?.repair).toMatch(/restart/i);
    });
});

describe('an agent that is not in the AgentInbox', () => {
    it('is wedged, and the diagnosis says its mail goes nowhere', async () => {
        const { inboxId } = await bootedAgent();

        agentInboxBroker.leave(inboxId);

        const d = only((await diagnose()).diagnoses);
        expect(d.condition).toBe('wedged');
        expect(d.findings.map((f) => f.ailment)).toContain('not-joined-to-inbox');
        expect(d.findings.map((f) => f.detail).join(' ')).toMatch(/nobody/i);
    });
});

describe('an agent whose pty has exited', () => {
    it('is wedged on the dead pty, and not on its four consequences', async () => {
        const { specId, inboxId } = await bootedAgent();

        terminalManager().kill(specId);
        harnessTransportRegistry.unbind(inboxId);
        agentInboxBroker.leave(inboxId);

        const d = only((await diagnose()).diagnoses);
        expect(d.condition).toBe('wedged');
        expect(d.findings.map((f) => f.ailment)).toEqual(['pty-exited']);
        expect(d.findings[0]?.repair).toMatch(/runAgent start/);
    });
});

describe('a registered agent that was never started', () => {
    it('is dormant, not broken', async () => {
        // A tool that reported this one wedged would have the operator restart a
        // perfectly ordinary dormant agent every time it looked.
        await registerAgent();

        const d = only((await diagnose()).diagnoses);
        expect(d.condition).toBe('dormant');
        expect(d.findings).toEqual([]);
        expect(d.terminalId).toBeNull();
    });
});

describe('a repair that would be refused', () => {
    it('says so, instead of sending the operator into the refusal', async () => {
        // `resolveRestartCommand` refuses a terminal with no captured session to
        // resume, so "restart it" is advice that bounces — and the operator's next
        // move after a bounce is usually stop-and-recreate, which is the thing the
        // refusal exists to prevent (genie#364).
        const { specId, inboxId } = await bootedAgent();
        agentInboxBroker.leave(inboxId);

        const spec = getTerminalSpec(specId)!;
        updateTerminalSpec(specId, {
            meta: { ...spec.meta, chat_session_id: undefined, agent_command: 'echo agent' },
        });

        const d = only((await diagnose()).diagnoses);
        expect(d.findings[0]?.ailment).toBe('not-joined-to-inbox');
        expect(d.findings[0]?.repair).toMatch(/would be refused/i);
        expect(d.findings[0]?.repair).toMatch(/no captured session to resume/i);
    });

    it('POSITIVE CONTROL — an agent that CAN be restarted gets no such warning', async () => {
        // Without this, a caveat that fired unconditionally would pass the test
        // above while telling the operator every restart on the machine is unsafe.
        const { inboxId } = await bootedAgent();
        agentInboxBroker.leave(inboxId);

        const d = only((await diagnose()).diagnoses);
        expect(d.findings[0]?.ailment).toBe('not-joined-to-inbox');
        expect(d.findings[0]?.repair).not.toMatch(/would be refused/i);
    });
});

describe('narrowing the sweep', () => {
    it('reports one agent when asked for one by name', async () => {
        await bootedAgent();
        await registerAgent('second-agent');

        expect((await diagnose()).diagnoses).toHaveLength(2);
        const one = only((await diagnose({ name: 'second-agent' })).diagnoses);
        expect(one.name).toBe('second-agent');
    });

    it('reports nothing, plainly, when the name matches no agent', async () => {
        await bootedAgent();

        const { diagnoses, note } = await diagnose({ name: 'not-a-real-agent' });
        expect(diagnoses).toEqual([]);
        expect(note).toMatch(/no agents/i);
    });
});
