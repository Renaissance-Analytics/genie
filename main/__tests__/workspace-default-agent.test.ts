import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * The WORKSPACE AGENT is a DESIGNATION, not an agent called "workspace".
 *
 * v50 seeded one row per workspace with `name = 'workspace'` and
 * `tui = NULL`, and nothing ever gave it a driver, a terminal or a purpose.
 * Once the renderer started drawing registered agents, those inert rows became
 * squares labelled "works…" that click into nothing — a phantom agent in every
 * workspace on the estate.
 *
 * The concept was wrong, not just the rendering. A workspace agent is whichever
 * of a workspace's REAL agents is designated the default and boots from the
 * workspace root. That is a property OF an agent, chosen by the owner in
 * workspace settings — which is exactly what `role = 'workspace'` plus the
 * existing `UNIQUE (workspace_id) WHERE role = 'workspace'` index already
 * expresses. The placeholders were the only thing in the way.
 *
 * Nothing is auto-designated. A workspace whose agents were never ranked has no
 * default until someone says so; picking for them would put an agent in the
 * boots-from-root position on the strength of a migration's guess.
 */

function fresh(): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
}

function seedWorkspace(db: Database.Database, id: string): void {
    db.prepare(
        `INSERT INTO workspaces
           (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
            shape, path, last_opened_at, created_by_genie)
         VALUES (?, 'tynn', ?, 'W', ?, 'W', 'simple', ?, null, 0)`,
    ).run(id, `p-${id}`, `p-${id}`, `/tmp/${id}`);
}

function addAgent(
    db: Database.Database,
    row: { id: string; ws: string; name: string; tui?: string | null; role?: string },
): void {
    db.prepare(
        `INSERT INTO workspace_agents
           (id, workspace_id, tui, name, purpose, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, 1, 1)`,
    ).run(row.id, row.ws, row.tui ?? null, row.name, row.role ?? 'specialized');
}

const roles = (db: Database.Database, ws: string) =>
    db
        .prepare<[string], { name: string; role: string }>(
            'SELECT name, role FROM workspace_agents WHERE workspace_id = ? ORDER BY name',
        )
        .all(ws);

describe('v57 — the phantom workspace agent is removed', () => {
    it('drops the inert placeholder v50 seeded', () => {
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        // Re-create the shape v50 left behind, then re-run the migration.
        addAgent(db, { id: 'workspace:ws-1', ws: 'ws-1', name: 'workspace', role: 'workspace' });

        db.prepare("DELETE FROM schema_version WHERE version >= 57").run();
        runMigrations(db);

        expect(roles(db, 'ws-1')).toEqual([]);
    });

    it('leaves a REAL agent that happens to be designated', () => {
        // The designation is the point. Only the driverless, terminal-less
        // placeholder goes — an agent someone actually made keeps its role.
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a1', ws: 'ws-1', name: 'tynn', tui: 'claude', role: 'workspace' });

        db.prepare("DELETE FROM schema_version WHERE version >= 57").run();
        runMigrations(db);

        expect(roles(db, 'ws-1')).toEqual([{ name: 'tynn', role: 'workspace' }]);
    });

    it('never leaves a workspace with two designated agents', () => {
        // The partial unique index says one per workspace; this asserts through
        // it, since a migration that promoted anything could violate it.
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a1', ws: 'ws-1', name: 'one', tui: 'claude', role: 'workspace' });

        expect(() =>
            addAgent(db, { id: 'a2', ws: 'ws-1', name: 'two', tui: 'codex', role: 'workspace' }),
        ).toThrow();
    });

    it('does NOT designate a replacement', () => {
        // POSITIVE CONTROL on "nothing is auto-designated": a workspace with one
        // obvious candidate is exactly where a migration would be tempted to
        // choose, and choosing puts an agent in the boots-from-root position on
        // the strength of a guess.
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'workspace:ws-1', ws: 'ws-1', name: 'workspace', role: 'workspace' });
        addAgent(db, { id: 'a1', ws: 'ws-1', name: 'tynn', tui: 'claude' });

        db.prepare("DELETE FROM schema_version WHERE version >= 57").run();
        runMigrations(db);

        expect(roles(db, 'ws-1')).toEqual([{ name: 'tynn', role: 'specialized' }]);
    });

    it('keeps a placeholder that somehow holds a terminal', () => {
        // Deleting a row that owns a live terminal would strand the terminal.
        // Inertness is the test, not the name.
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, type, meta_json, sort_order, created_at)
             VALUES ('t1', 'ws-1', 'l', '/tmp', 'terminal', '{}', 0, 1)`,
        ).run();
        db.prepare(
            `INSERT INTO workspace_agents
               (id, workspace_id, tui, name, purpose, role, terminal_spec_id, created_at, updated_at)
             VALUES ('workspace:ws-1', 'ws-1', NULL, 'workspace', '', 'workspace', 't1', 1, 1)`,
        ).run();

        db.prepare("DELETE FROM schema_version WHERE version >= 57").run();
        runMigrations(db);

        expect(roles(db, 'ws-1')).toEqual([{ name: 'workspace', role: 'workspace' }]);
    });
});
