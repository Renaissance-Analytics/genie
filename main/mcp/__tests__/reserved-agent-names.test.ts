import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Reserved agent names are refused AT THE TOOL BOUNDARY (Tynn story #262).
 *
 * The owner's rule: *"NO GENERAL. WE need a term block list. so no genie or
 * tynn either (except tynn is allowed in this specific workspace of course)"*.
 *
 * Asserted through the real `registerAgent` handler rather than on
 * `reservedNameRefusal`'s return value. The pure decision is unit-tested next to
 * itself (`agents/__tests__/reserved-names.test.ts`); what actually protects the
 * database is that registration CALLS it, and a test of the resolver alone would
 * pass for the whole time nothing did — which is exactly how `role='workspace'`
 * went unassigned for 29 agents.
 *
 * REAL: the SQLite database (real migrations, real workspace rows), the real
 * `registerAgent` MCP handler, and the real refusal it returns.
 * FAKED: the approval modal and Electron's tray bootstrap — the process
 * boundaries. Nothing that decides a name is mocked.
 */

vi.mock('../../ask/force-question', () => ({
    forceQuestion: async () => ({ cancelled: false, answers: [{ selected: ['Approve'] }] }),
}));

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-reserved-names-'));
const dataDir = path.join(tmpRoot, 'userData');
const plainDir = path.join(tmpRoot, 'plain');
const sacredDir = path.join(tmpRoot, 'sacred');
for (const d of [dataDir, plainDir, sacredDir]) fs.mkdirSync(d, { recursive: true });
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const PLAIN_WS = 'ws-plain';
const SACRED_WS = 'ws-sacred';
const PLAIN_CALLER = 'term-plain-caller';
const SACRED_CALLER = 'term-sacred-caller';

function makeWorkspace(id: string, name: string, dir: string, sacredName: string | null): void {
    addWorkspace({
        id,
        backend: 'tynn',
        project_id: id,
        project_name: name,
        tynn_project_id: id,
        tynn_project_name: name,
        shape: 'simple',
        path: dir,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
        sacred_name: sacredName,
    });
}

makeWorkspace(PLAIN_WS, 'Ordinary Project', plainDir, null);
// The grant Tynn hands the sacred workspace: ONE reserved term, not a boolean.
makeWorkspace(SACRED_WS, 'Tynn.ai', sacredDir, 'tynn');

for (const [id, ws, cwd] of [
    [PLAIN_CALLER, PLAIN_WS, plainDir],
    [SACRED_CALLER, SACRED_WS, sacredDir],
] as const) {
    createTerminalSpec({ id, workspace_id: ws, label: 'Caller', cwd, type: 'terminal', meta: {} });
}

function register(caller: string, name: string) {
    return registerAgentForMcp(caller, { name, purpose: `Reserved-name test for ${name}`, agent: 'claude' });
}

beforeEach(() => {
    for (const ws of [PLAIN_WS, SACRED_WS]) {
        for (const a of listWorkspaceAgents(ws)) deleteWorkspaceAgent(a.id);
    }
    for (const d of [plainDir, sacredDir]) {
        fs.rmSync(path.join(d, '.agents'), { recursive: true, force: true });
    }
});

describe('an ordinary workspace refuses every reserved name', () => {
    it.each(['general', 'genie', 'tynn'])('refuses %s', async (name) => {
        const res = await register(PLAIN_CALLER, name);

        expect(res.ok).toBe(false);
        expect(String((res as { error?: string }).error)).toContain(name);
    });

    it('writes no agent row when it refuses', async () => {
        await register(PLAIN_CALLER, 'general');

        expect(listWorkspaceAgents(PLAIN_WS)).toHaveLength(0);
    });

    it('leaves no .agents/<name>/AGENT.md behind for a refused name', async () => {
        // The persona file is written during registration. A refusal that lands
        // after the write would leave the workspace carrying a file for an agent
        // that does not exist — and `general` is precisely the name we are
        // trying to stop appearing anywhere.
        await register(PLAIN_CALLER, 'general');

        expect(fs.existsSync(path.join(plainDir, '.agents', 'general', 'AGENT.md'))).toBe(false);
    });

    it('POSITIVE CONTROL: still registers an ordinary name', async () => {
        // Without this, every assertion above would also pass if registration
        // were broken outright and refused everything.
        const res = await register(PLAIN_CALLER, 'frontend');

        expect(res.ok).toBe(true);
        expect(listWorkspaceAgents(PLAIN_WS).map((a) => a.name)).toContain('frontend');
    });
});

describe('the sacred workspace holds its one granted name', () => {
    it('registers an agent named tynn', async () => {
        const res = await register(SACRED_CALLER, 'tynn');

        expect(res.ok).toBe(true);
        expect(listWorkspaceAgents(SACRED_WS).map((a) => a.name)).toContain('tynn');
    });

    it('still refuses the reserved terms it was NOT granted', async () => {
        // Sacred is not a skeleton key.
        expect((await register(SACRED_CALLER, 'general')).ok).toBe(false);
        expect((await register(SACRED_CALLER, 'genie')).ok).toBe(false);
    });
});
