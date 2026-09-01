import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The FIRST agent registered in a workspace becomes that workspace's agent.
 *
 * The owner's rule: *"The first agent created is the workspace agent by
 * default."* The AMS guide has always said every workspace has a Workspace
 * Agent — "its terminal is the one that drives most work there, and TWA is the
 * master of the agents it spawns" — the role existed in the schema, and
 * `idx_workspace_agents_master` enforced one per workspace. Nothing ever
 * CREATED one: 29 agents across a dozen workspaces on this workstation, zero
 * with `role='workspace'` (genie#324).
 *
 * Asserted at the TOOL boundary, not on `firstAgentRole`'s return value. The
 * pure decision is unit-tested next to itself; what was actually broken is that
 * nothing called it, and a test of the resolver would have passed the whole
 * time the role went unassigned.
 *
 * REAL: the SQLite database (real migrations, real workspace rows), the real
 * `registerAgent` MCP handler, and the real agent rows it writes.
 * FAKED: the approval modal and Electron's tray bootstrap — the process
 * boundaries. Nothing that decides a role is mocked.
 */

vi.mock('../../ask/force-question', () => ({
    forceQuestion: async () => ({ cancelled: false, answers: [{ selected: ['Approve'] }] }),
}));

// host-tools' import graph reaches main/tray.ts, which runs the Electron app
// bootstrap at MODULE LOAD. Same cut as agent-cap-enforcement.test.ts.
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
    deleteWorkspaceAgent,
    initDatabase,
    listWorkspaceAgents,
} from '../../db';
import { registerAgentForMcp } from '../host-tools';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-first-agent-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const WS_ID = 'ws-first';
const CALLER_ID = 'term-first-caller';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'First Agent Demo',
    tynn_project_id: WS_ID,
    tynn_project_name: 'First Agent Demo',
    shape: 'simple',
    path: wsDir,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

createTerminalSpec({
    id: CALLER_ID,
    workspace_id: WS_ID,
    label: 'Caller',
    cwd: wsDir,
    type: 'terminal',
    meta: {},
});

let seq = 0;

async function register(): Promise<string> {
    const name = `agent-${++seq}`;
    const res = await registerAgentForMcp(CALLER_ID, {
        name,
        purpose: `First-agent test ${name}`,
        agent: 'claude',
    });
    if (!res.ok) throw new Error(`registerAgent refused: ${JSON.stringify(res)}`);
    return name;
}

function roleOf(name: string): string | undefined {
    return listWorkspaceAgents(WS_ID).find((a) => a.name === name)?.role;
}

beforeEach(() => {
    for (const a of listWorkspaceAgents(WS_ID)) deleteWorkspaceAgent(a.id);
    // `.agents/<name>/` persists across registrations; a stale folder does not
    // change the role, but starting clean keeps a failure readable.
    fs.rmSync(path.join(wsDir, '.agents'), { recursive: true, force: true });
});

describe('the first agent in a workspace', () => {
    it('is registered as the WORKSPACE agent', async () => {
        const first = await register();

        expect(roleOf(first)).toBe('workspace');
    });

    it('and every agent after it is specialized', async () => {
        // POSITIVE CONTROL: a wiring that made EVERY agent the workspace agent
        // would satisfy the test above and then fail against
        // `idx_workspace_agents_master`, which is UNIQUE per workspace.
        await register();
        const second = await register();
        const third = await register();

        expect(roleOf(second)).toBe('specialized');
        expect(roleOf(third)).toBe('specialized');
    });

    it('leaves exactly one workspace agent, however many are registered', async () => {
        await register();
        await register();
        await register();

        const masters = listWorkspaceAgents(WS_ID).filter((a) => a.role === 'workspace');
        expect(masters).toHaveLength(1);
    });

    it('hands the role on when the workspace agent is deleted', async () => {
        // The role is not a life sentence — see `resolveAgentDeletion`. Once
        // the holder is gone the workspace has none, so the next agent
        // registered takes it. Without this, deleting the TWA would leave a
        // workspace permanently without one.
        const first = await register();
        const master = listWorkspaceAgents(WS_ID).find((a) => a.name === first);
        deleteWorkspaceAgent(master!.id);

        const next = await register();

        expect(roleOf(next)).toBe('workspace');
    });
});
