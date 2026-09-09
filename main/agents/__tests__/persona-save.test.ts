import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    addWorkspace,
    createWorkspaceAgent,
    deleteWorkspaceAgent,
    initDatabase,
    listWorkspaceAgents,
} from '../../db';
import { agentManagerState, saveAgentPersona } from '../agent-manager';
import { resolveAgentDeletion } from '../deletion';
import { getWorkspaceAgentById } from '../lookup';
import { parseAgentFile } from '../agent-file';

/**
 * `saveAgentPersona` against a real db + a real (temporary) filesystem —
 * genie#570.
 *
 * The bug: an agent whose row carries no `persona_path` was told "there is
 * nowhere to save this. Re-register the agent to give it one" — three lines
 * below a docblock promising the opposite. The owner's instruction is "if an
 * agent has no agents.md file yet, then create it", so the path is DERIVED
 * (`.agents/<name>/AGENT.md`, the convention `resolveAgentRegistration` already
 * commits to) and recorded on the row.
 *
 * Every workspace here is a `mkdtemp` directory. Nothing in this file may write
 * into a real workspace's `.agents/` — there are live agents on the machine
 * this runs on.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-persona-save-'));
const dataDir = path.join(tmpRoot, 'userData');
fs.mkdirSync(dataDir, { recursive: true });
(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;
initDatabase(dataDir);

const wsPath = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsPath, { recursive: true });

const WS = 'ws-persona';
addWorkspace({
    id: WS,
    backend: 'tynn',
    project_id: WS,
    project_name: WS,
    tynn_project_id: WS,
    tynn_project_name: WS,
    shape: 'simple',
    path: wsPath,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

let seq = 0;
function register(opts: { name?: string; personaPath?: string | null } = {}): string {
    const id = `agent-${++seq}`;
    createWorkspaceAgent({
        id,
        workspace_id: WS,
        tui: 'claude',
        name: opts.name ?? `saver-${seq}`,
        purpose: 'test agent',
        avatar: null,
        boot_cwd: null,
        persona_path: opts.personaPath ?? null,
        role: 'specialized',
        parent_agent_id: null,
        reachability: 'workspace',
        wake_on_dm: 1,
    });
    return id;
}

beforeEach(() => {
    for (const a of listWorkspaceAgents(WS)) deleteWorkspaceAgent(a.id);
    fs.rmSync(path.join(wsPath, '.agents'), { recursive: true, force: true });
});

describe('saveAgentPersona with no recorded path', () => {
    it('CREATES .agents/<name>/AGENT.md and records it on the row', () => {
        const id = register({ name: 'fancy' });

        const result = saveAgentPersona(id, { body: 'You are fancy. Do the fancy things.\n' });

        expect(result).toEqual({ ok: true });
        const derived = path.resolve(wsPath, '.agents', 'fancy', 'AGENT.md');
        expect(fs.existsSync(derived)).toBe(true);
        expect(fs.readFileSync(derived, 'utf8')).toContain('Do the fancy things.');
        // Recorded, so the NEXT save is the ordinary path and every other
        // surface (deletion, the roster, `agentAllowedTuis`) can find the file.
        expect(getWorkspaceAgentById(id)?.persona_path).toBe(derived);
    });

    it('derives a path DELETION can reason about', () => {
        const id = register({ name: 'fancy' });
        saveAgentPersona(id, { body: 'hello\n' });

        const agent = getWorkspaceAgentById(id)!;
        const plan = resolveAgentDeletion(wsPath, agent, 'delete');

        expect(plan.ok).toBe(true);
        expect(plan.ok && plan.plan.removeFiles).toBe(true);
        expect(plan.ok && plan.plan.agentDir).toBe(path.resolve(wsPath, '.agents', 'fancy'));
    });

    it('ADOPTS an existing file at the derived path instead of clobbering it', () => {
        // The file an UNMOUNT deliberately left behind, or a teammate authored
        // and committed. Registration never overwrites one; neither may this.
        const derived = path.resolve(wsPath, '.agents', 'keeper', 'AGENT.md');
        fs.mkdirSync(path.dirname(derived), { recursive: true });
        fs.writeFileSync(
            derived,
            '---\nname: keeper\npurpose: mind the shop\nmodel: opus\n---\nAuthored by a human.\n',
        );
        const id = register({ name: 'keeper' });

        const result = saveAgentPersona(id, { body: 'Authored by a human, plus a line.\n' });

        expect(result).toEqual({ ok: true });
        const parsed = parseAgentFile(fs.readFileSync(derived, 'utf8'));
        expect(parsed.body.trim()).toBe('Authored by a human, plus a line.');
        // Everything the edit did not name survives — including the key Genie
        // has no field for.
        expect(parsed.config.purpose).toBe('mind the shop');
        expect(parsed.extra).toEqual([['model', 'opus']]);
        expect(getWorkspaceAgentById(id)?.persona_path).toBe(derived);
    });

    it('reports a real write failure, and records NO path when nothing landed', () => {
        // `.agents/<name>` is a FILE, so mkdirSync cannot make it a directory.
        const agentDir = path.resolve(wsPath, '.agents', 'blocked');
        fs.mkdirSync(path.dirname(agentDir), { recursive: true });
        fs.writeFileSync(agentDir, 'not a directory');
        const id = register({ name: 'blocked' });

        const result = saveAgentPersona(id, { body: 'never lands\n' });

        expect(result.ok).toBe(false);
        // The WRITE's failure, not the refusal this issue removes — otherwise
        // this passes on the bug it is meant to outlive.
        expect(result.error).toContain('Could not write');
        expect(result.error).toContain(agentDir);
        // A path recorded for a file that was never written would leave the row
        // pointing at nothing and report success next time.
        expect(getWorkspaceAgentById(id)?.persona_path).toBeNull();
    });

    it('normalises the name, so no agent can write outside .agents/', () => {
        const id = register({ name: '../../escape' });

        expect(saveAgentPersona(id, { body: 'contained\n' })).toEqual({ ok: true });

        const recorded = getWorkspaceAgentById(id)!.persona_path!;
        const agentsRoot = path.resolve(wsPath, '.agents');
        const rel = path.relative(agentsRoot, recorded);
        expect(rel.startsWith('..')).toBe(false);
        expect(path.isAbsolute(rel)).toBe(false);
        expect(fs.existsSync(recorded)).toBe(true);
    });

    it('gives two names differing only by case ONE deterministic path', () => {
        // The slug is lowercase on every platform, so a case-insensitive
        // filesystem and a case-sensitive one agree about which file this is —
        // rather than one file on Windows and two on Linux.
        const upper = register({ name: 'Fancy' });
        saveAgentPersona(upper, { body: 'first\n' });
        const lower = register({ name: 'fancy' });
        saveAgentPersona(lower, { body: 'second\n' });

        const a = getWorkspaceAgentById(upper)!.persona_path;
        const b = getWorkspaceAgentById(lower)!.persona_path;
        expect(a).toBe(path.resolve(wsPath, '.agents', 'fancy', 'AGENT.md'));
        expect(b).toBe(a);
    });

    it('SHOWS the path it would write, so the editor names a real file', () => {
        const id = register({ name: 'fancy' });

        const state = agentManagerState(id);

        expect(state.ok).toBe(true);
        expect(state.persona?.path).toBe(path.resolve(wsPath, '.agents', 'fancy', 'AGENT.md'));
        expect(state.persona?.exists).toBe(false);
    });
});

describe('saveAgentPersona with a recorded path', () => {
    it('writes to the recorded path and leaves it alone', () => {
        const recorded = path.resolve(wsPath, 'elsewhere', 'PERSONA.md');
        fs.mkdirSync(path.dirname(recorded), { recursive: true });
        fs.writeFileSync(recorded, '---\nname: settled\n---\nOriginal.\n');
        const id = register({ name: 'settled', personaPath: recorded });

        const result = saveAgentPersona(id, { body: 'Rewritten.\n' });

        expect(result).toEqual({ ok: true });
        expect(fs.readFileSync(recorded, 'utf8')).toContain('Rewritten.');
        expect(getWorkspaceAgentById(id)?.persona_path).toBe(recorded);
        // Nothing was invented under `.agents/` for an agent that already had a
        // home.
        expect(fs.existsSync(path.resolve(wsPath, '.agents', 'settled'))).toBe(false);
    });

    it('still CREATES the file when the recorded path points at nothing', () => {
        // Deliberately NOT the path derivation would pick, so this cannot pass
        // by accidentally agreeing with the derived one.
        const recorded = path.resolve(wsPath, 'elsewhere', 'GHOST.md');
        const id = register({ name: 'ghost', personaPath: recorded });

        expect(saveAgentPersona(id, { body: 'Written at last.\n' })).toEqual({ ok: true });
        expect(fs.readFileSync(recorded, 'utf8')).toContain('Written at last.');
        expect(fs.existsSync(path.resolve(wsPath, '.agents', 'ghost'))).toBe(false);
    });
});
