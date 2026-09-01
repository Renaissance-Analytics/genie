import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * v63 — the `provider` COLUMN is `tui` (Tynn story #262).
 *
 * The owner's rule, already recorded in v60: *"provider should be tui because
 * the tui is what determines the provider and supports TUIs that can use any
 * provider, so provider itself is not important for agent identity."*
 *
 * v60 did the part that mattered — identity became (workspace, tui, name) — but
 * kept the column called `provider`, so the schema said one thing and the rule
 * said another. This finishes it.
 *
 * A RENAME, not a new column plus a backfill: the values are already correct and
 * copying them would leave two columns that can disagree. SQLite rewrites the
 * dependent INDEX definitions as part of `ALTER TABLE … RENAME COLUMN`, which is
 * what makes this safe on the unique indexes that key on it.
 */

function fresh(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
}

const columns = (db: Database.Database, table: string): string[] =>
    db
        .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);

describe('v63 — the agent driver column is called `tui`', () => {
    it('renames workspace_agents.provider to tui', () => {
        const db = fresh();

        expect(columns(db, 'workspace_agents')).toContain('tui');
        expect(columns(db, 'workspace_agents')).not.toContain('provider');
    });

    it('renames agent_runtimes.provider to tui', () => {
        const db = fresh();

        expect(columns(db, 'agent_runtimes')).toContain('tui');
        expect(columns(db, 'agent_runtimes')).not.toContain('provider');
    });

    it('carries the VALUES across, rather than emptying the column', () => {
        // POSITIVE CONTROL on the rename: a drop-and-add would satisfy the two
        // assertions above and silently lose every agent's driver.
        const db = fresh();
        db.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
                shape, path, last_opened_at, created_by_genie)
             VALUES ('w', 'tynn', 'p', 'W', 'p', 'W', 'simple', '/tmp/w', null, 0)`,
        ).run();
        db.prepare(
            `INSERT INTO workspace_agents
               (id, workspace_id, tui, name, purpose, role, created_at, updated_at)
             VALUES ('a', 'w', 'codex', 'n', '', 'specialized', 1, 1)`,
        ).run();

        const row = db
            .prepare<[string], { tui: string }>('SELECT tui FROM workspace_agents WHERE id = ?')
            .get('a')!;
        expect(row.tui).toBe('codex');
    });

    it('keeps the unique index keying on the renamed column', () => {
        // v60's key is (workspace_id, provider, name). If SQLite had not
        // rewritten the index definition, the key would be gone and two agents
        // could collide again — the exact thing v60 was written to settle.
        const db = fresh();
        const sql = db
            .prepare<[string], { sql: string | null }>(
                `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
            )
            .get('idx_workspace_agents_tui_name');

        expect(sql?.sql ?? '').toContain('tui');
        expect(sql?.sql ?? '').not.toContain('provider');
    });

    it('is idempotent — re-running the ladder converges', () => {
        const db = fresh();
        db.prepare('DELETE FROM schema_version WHERE version >= 63').run();
        runMigrations(db);

        expect(columns(db, 'workspace_agents')).toContain('tui');
        expect(columns(db, 'agent_runtimes')).toContain('tui');
    });
});
