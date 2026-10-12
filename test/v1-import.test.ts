import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planV1Import, relativePersona, V1_SYSTEM_WORKSPACE, type V1Catalog } from '../src/core/v1-import.js';
import { readV1Catalog } from '../src/main/v1-import.js';

/**
 * IMPORTING GENIE 1's WORKSPACES AND AGENTS. The owner upgraded 0.7.0-beta.342 → 2.0.0-beta.5
 * (2026-10-11 21:32) and saw "Nothing is being worked on yet": 27 workspaces and 34 agents sat in
 * `%APPDATA%\genie\genie.db` and Genie 2 read none of them. The planner is pure; the reader opens
 * a database built here with v1's REAL `CREATE TABLE` statements (copied from that very file).
 */

const v1Workspaces = `CREATE TABLE "workspaces" ( id TEXT PRIMARY KEY, tynn_project_id TEXT NOT NULL, tynn_project_name TEXT NOT NULL, shape TEXT NOT NULL CHECK (shape IN ('agi','simple')), path TEXT NOT NULL, editor TEXT, editor_cmd TEXT, start_cmd TEXT, env_file TEXT, last_opened_at TEXT, created_by_genie INTEGER NOT NULL DEFAULT 0, backend TEXT NOT NULL DEFAULT 'tynn', project_id TEXT, project_name TEXT, sort_order INTEGER NOT NULL DEFAULT 0, mcp_enabled INTEGER NOT NULL DEFAULT 0 )`;
const v1Agents = `CREATE TABLE workspace_agents ( id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, tui TEXT, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', avatar TEXT, boot_cwd TEXT, persona_path TEXT, role TEXT NOT NULL DEFAULT 'specialized', parent_agent_id TEXT, terminal_spec_id TEXT, reachability TEXT NOT NULL DEFAULT 'workspace', wake_on_dm INTEGER NOT NULL DEFAULT 1, ready_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )`;

const catalog: V1Catalog = {
    workspaces: [
        { id: V1_SYSTEM_WORKSPACE, path: 'C:\\Users\\someone\\.gosa', name: 'System', shape: 'agi' },
        { id: '01k95ewyzkvkbxtpdt8b3qvyqk', path: 'C:\\_Projects\\tynn.ai', name: 'Tynn.ai', shape: 'agi' },
        { id: '01kex8dep28vm4awnsv3h8avd3', path: 'C:\\_Projects\\_packages\\fancy.agi', name: 'Fancy', shape: 'agi' },
        { id: '01gone', path: 'D:\\moved\\away.agi', name: 'Moved', shape: 'simple' },
    ],
    agents: [
        { id: 'a1', workspaceId: '01k95ewyzkvkbxtpdt8b3qvyqk', name: 'tynn', tui: 'claude', personaPath: 'C:\\_Projects\\tynn.ai\\.agents\\tynn\\AGENT.md' },
        { id: 'a2', workspaceId: '01k95ewyzkvkbxtpdt8b3qvyqk', name: 'tynn-slave', tui: 'codex', personaPath: null },
        { id: 'a3', workspaceId: '01k95ewyzkvkbxtpdt8b3qvyqk', name: 'tynn', tui: 'codex', personaPath: null },
        { id: 'a4', workspaceId: '01kex8dep28vm4awnsv3h8avd3', name: 'fancy', tui: 'gemini', personaPath: null },
        { id: 'a5', workspaceId: '01kex8dep28vm4awnsv3h8avd3', name: 'elsewhere', tui: 'claude', personaPath: 'C:\\other\\AGENT.md' },
        { id: 'a6', workspaceId: '01gone', name: 'orphan', tui: 'claude', personaPath: null },
        { id: 'a7', workspaceId: V1_SYSTEM_WORKSPACE, name: 'genie', tui: 'claude', personaPath: null },
    ],
};
const exists = (p: string) => !p.startsWith('D:');

describe('planV1Import', () => {
    it('imports every real workspace whose folder exists, keeps v1 ids, skips the system workspace and a missing folder — and says so', () => {
        const plan = planV1Import(catalog, { workspaceIds: [], agents: [] }, exists);
        expect(plan.workspaces).toEqual([
            { id: '01k95ewyzkvkbxtpdt8b3qvyqk', path: 'C:\\_Projects\\tynn.ai' },
            { id: '01kex8dep28vm4awnsv3h8avd3', path: 'C:\\_Projects\\_packages\\fancy.agi' },
        ]);
        expect(plan.skipped).toContainEqual(expect.stringMatching(/workspace System: v1's system workspace/));
        expect(plan.skipped).toContainEqual(expect.stringMatching(/workspace Moved: its folder D:\\moved\\away\.agi no longer exists/));
    });

    it('imports claude and codex agents with a workspace-relative persona; skips other tuis, duplicates, orphans and the system agent, each with its reason', () => {
        const plan = planV1Import(catalog, { workspaceIds: [], agents: [] }, exists);
        expect(plan.agents).toEqual([
            { workspaceId: '01k95ewyzkvkbxtpdt8b3qvyqk', provider: 'claude', name: 'tynn', instructions: '.agents/tynn/AGENT.md' },
            { workspaceId: '01k95ewyzkvkbxtpdt8b3qvyqk', provider: 'codex', name: 'tynn-slave', instructions: null },
            { workspaceId: '01kex8dep28vm4awnsv3h8avd3', provider: 'claude', name: 'elsewhere', instructions: null },
        ]);
        expect(plan.skipped).toContainEqual(expect.stringMatching(/agent tynn: a second agent of that name/));
        expect(plan.skipped).toContainEqual(expect.stringMatching(/agent fancy: runs on "gemini"/));
        expect(plan.skipped).toContainEqual(expect.stringMatching(/agent orphan: its workspace was not imported/));
        expect(plan.skipped).toContainEqual(expect.stringMatching(/agent genie: belonged to v1's system workspace/));
        expect(plan.skipped).toContainEqual(expect.stringMatching(/agent elsewhere: persona C:\\other\\AGENT\.md is outside/));
    });

    it('leaves what the registry already has alone — a second boot imports nothing twice', () => {
        const plan = planV1Import(catalog, { workspaceIds: ['01k95ewyzkvkbxtpdt8b3qvyqk'], agents: [{ workspaceId: '01k95ewyzkvkbxtpdt8b3qvyqk', name: 'tynn' }] }, exists);
        expect(plan.workspaces.map((w) => w.id)).toEqual(['01kex8dep28vm4awnsv3h8avd3']);
        expect(plan.agents.map((a) => a.name)).toEqual(['tynn-slave', 'elsewhere']);
    });

    it('a null catalog (cannot see v1) plans nothing and claims nothing', () => {
        expect(planV1Import(null, { workspaceIds: [], agents: [] }, exists)).toEqual({ workspaces: [], agents: [], skipped: [] });
    });

    it('relativePersona: inside the workspace → forward-slash relative; outside → null; case-insensitive drive letters', () => {
        expect(relativePersona('C:\\_Projects\\tynn.ai\\.agents\\tynn\\AGENT.md', 'C:\\_Projects\\tynn.ai')).toBe('.agents/tynn/AGENT.md');
        expect(relativePersona('c:/_projects/tynn.ai/.agents/x/AGENT.md', 'C:\\_Projects\\tynn.ai')).toBe('.agents/x/AGENT.md');
        expect(relativePersona('C:\\other\\AGENT.md', 'C:\\_Projects\\tynn.ai')).toBeNull();
        expect(relativePersona(null, 'C:\\_Projects\\tynn.ai')).toBeNull();
    });
});

describe('readV1Catalog', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'genie2-v1-catalog-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

    it("reads workspaces and agents from a database with v1's real schema, in sort order, read-only", () => {
        const file = join(dir, 'genie.db');
        const db = new DatabaseSync(file);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec(v1Workspaces);
        db.exec(v1Agents);
        db.prepare("INSERT INTO workspaces (id, tynn_project_id, tynn_project_name, shape, path, project_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)").run('01b', 'p', 'Second', 'agi', 'C:\\w\\second', 'Second', 1);
        db.prepare("INSERT INTO workspaces (id, tynn_project_id, tynn_project_name, shape, path, project_name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)").run('01a', 'p', 'First', 'simple', 'C:\\w\\first', null, 0);
        db.prepare('INSERT INTO workspace_agents (id, workspace_id, tui, name, persona_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('a', '01a', 'claude', 'kai', 'C:\\w\\first\\.agents\\kai\\AGENT.md', 2, 2);
        db.prepare('INSERT INTO workspace_agents (id, workspace_id, tui, name, persona_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('b', '01b', null, 'nameless-tui', null, 1, 1);
        db.close();
        expect(readV1Catalog(file)).toEqual({
            workspaces: [
                { id: '01a', path: 'C:\\w\\first', name: 'First', shape: 'simple' },
                { id: '01b', path: 'C:\\w\\second', name: 'Second', shape: 'agi' },
            ],
            agents: [
                { id: 'b', workspaceId: '01b', name: 'nameless-tui', tui: null, personaPath: null },
                { id: 'a', workspaceId: '01a', name: 'kai', tui: 'claude', personaPath: 'C:\\w\\first\\.agents\\kai\\AGENT.md' },
            ],
        });
    });

    it('cannot-see is null: no file, or a database without the workspaces table; the tables with no rows is an empty catalog', () => {
        expect(readV1Catalog(join(dir, 'missing.db'))).toBeNull();
        const bare = join(dir, 'bare.db');
        const db = new DatabaseSync(bare);
        db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
        db.close();
        expect(readV1Catalog(bare)).toBeNull();
        const empty = join(dir, 'empty.db');
        const db2 = new DatabaseSync(empty);
        db2.exec(v1Workspaces);
        db2.close();
        expect(readV1Catalog(empty)).toEqual({ workspaces: [], agents: [] });
    });
});
