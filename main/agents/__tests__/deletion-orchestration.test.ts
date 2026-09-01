import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    addWorkspace,
    createWorkspaceAgent,
    initDatabase,
    listWorkspaceAgents,
    deleteWorkspaceAgent,
} from '../../db';
import { deleteRegisteredAgent } from '../deletion';
import { getWorkspaceAgentById } from '../lookup';

/**
 * `deleteRegisteredAgent` end to end, against a real db + real filesystem —
 * genie#311.
 *
 * Every agent here is DORMANT (no `terminal_spec_id`, no runtimes), so this
 * never reaches `killTerminalById`'s real pty teardown — that path is E2E-only
 * (CI VMs), never exercised from a plain `vitest run`. What IS exercised here,
 * for real, is the part that is easy to get wrong silently: which files
 * survive UNMOUNT vs DELETE, and whether the Tynn-link detection reads the
 * actual `project.json` a workspace carries.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-agent-deletion-'));
const dataDir = path.join(tmpRoot, 'userData');
fs.mkdirSync(dataDir, { recursive: true });
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;
initDatabase(dataDir);

const linkedWsPath = path.join(tmpRoot, 'linked-ws');
const plainWsPath = path.join(tmpRoot, 'plain-ws');
fs.mkdirSync(linkedWsPath, { recursive: true });
fs.mkdirSync(plainWsPath, { recursive: true });
fs.writeFileSync(
    path.join(linkedWsPath, 'project.json'),
    JSON.stringify({ tynn: { projectId: 'proj-123', project: 'demo' } }),
);

const LINKED_WS = 'ws-linked';
const PLAIN_WS = 'ws-plain';
for (const [id, p] of [
    [LINKED_WS, linkedWsPath],
    [PLAIN_WS, plainWsPath],
] as const) {
    addWorkspace({
        id,
        backend: 'tynn',
        project_id: id,
        project_name: id,
        tynn_project_id: id,
        tynn_project_name: id,
        shape: 'simple',
        path: p,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
    });
}

let seq = 0;
function registerAgent(
    workspaceId: string,
    wsPath: string,
    opts: { withFile?: boolean; role?: 'specialized' | 'workspace' } = {},
): string {
    const id = `agent-${++seq}`;
    const name = `deletable-${seq}`;
    const personaPath = path.resolve(wsPath, '.agents', name, 'AGENT.md');
    if (opts.withFile) {
        fs.mkdirSync(path.dirname(personaPath), { recursive: true });
        fs.writeFileSync(personaPath, `---\nname: ${name}\n---\nYou are ${name}.\n`);
    }
    createWorkspaceAgent({
        id,
        workspace_id: workspaceId,
        provider: null,
        name,
        purpose: 'test agent',
        avatar: null,
        boot_cwd: null,
        persona_path: opts.withFile ? personaPath : null,
        role: opts.role ?? 'specialized',
        parent_agent_id: null,
        reachability: 'workspace',
        wake_on_dm: 1,
    });
    return id;
}

beforeEach(() => {
    for (const wsId of [LINKED_WS, PLAIN_WS]) {
        for (const a of listWorkspaceAgents(wsId)) {
            if (a.role !== 'workspace') deleteWorkspaceAgent(a.id);
        }
    }
});

describe('deleteRegisteredAgent', () => {
    it('UNMOUNT removes the db row but KEEPS the .agents/<name>/ file', () => {
        const id = registerAgent(PLAIN_WS, plainWsPath, { withFile: true });
        const agentDir = path.dirname(getWorkspaceAgentById(id)!.persona_path!);
        expect(fs.existsSync(agentDir)).toBe(true);

        const result = deleteRegisteredAgent(id, 'unmount');

        expect(result.ok).toBe(true);
        expect(result.filesRemoved).toBe(false);
        expect(getWorkspaceAgentById(id)).toBeUndefined();
        expect(fs.existsSync(agentDir)).toBe(true);
    });

    it('DELETE removes the db row AND the .agents/<name>/ file', () => {
        const id = registerAgent(PLAIN_WS, plainWsPath, { withFile: true });
        const agentDir = path.dirname(getWorkspaceAgentById(id)!.persona_path!);
        expect(fs.existsSync(agentDir)).toBe(true);

        const result = deleteRegisteredAgent(id, 'delete');

        expect(result.ok).toBe(true);
        expect(result.filesRemoved).toBe(true);
        expect(getWorkspaceAgentById(id)).toBeUndefined();
        expect(fs.existsSync(agentDir)).toBe(false);
    });

    it('reports workspaceTynnLinked from the workspace’s real project.json', () => {
        const linked = registerAgent(LINKED_WS, linkedWsPath, { withFile: true });
        const plain = registerAgent(PLAIN_WS, plainWsPath, { withFile: true });

        expect(deleteRegisteredAgent(linked, 'unmount').workspaceTynnLinked).toBe(true);
        expect(deleteRegisteredAgent(plain, 'unmount').workspaceTynnLinked).toBe(false);
    });

    it('never carries a tynnNote or a removeFromTynn option — there is no per-agent Tynn link to act on', () => {
        // A checkbox offering to "remove it from Tynn" was tried here and
        // pulled: Genie has no per-agent Tynn record, so the control promised
        // an action the code could not perform. This guards against that
        // reappearing on the result shape, whether or not the workspace
        // itself is Tynn-linked.
        const linked = registerAgent(LINKED_WS, linkedWsPath, {});
        const plain = registerAgent(PLAIN_WS, plainWsPath, {});

        expect(deleteRegisteredAgent(linked, 'delete')).not.toHaveProperty('tynnNote');
        expect(deleteRegisteredAgent(plain, 'delete')).not.toHaveProperty('tynnNote');
    });

    it('refuses to delete the WORKSPACE agent', () => {
        // A new workspace gets no placeholder agent (v50's did, and it became
        // a phantom square — see the comment on `addWorkspace`), so this
        // registers one explicitly rather than relying on auto-seeding.
        const wsAgentId = `workspace-agent-${++seq}`;
        createWorkspaceAgent({
            id: wsAgentId,
            workspace_id: PLAIN_WS,
            provider: null,
            name: `workspace-role-${seq}`,
            purpose: 'drive this workspace',
            avatar: null,
            boot_cwd: null,
            persona_path: null,
            role: 'workspace',
            parent_agent_id: null,
            reachability: 'workspace',
            wake_on_dm: 1,
        });

        const result = deleteRegisteredAgent(wsAgentId, 'delete');

        expect(result.ok).toBe(false);
        // Still registered — a refusal must not have deleted it anyway.
        expect(getWorkspaceAgentById(wsAgentId)).toBeDefined();
    });

    it('refuses an unknown agent id rather than throwing', () => {
        const result = deleteRegisteredAgent('agent-does-not-exist', 'delete');
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
    });
});
