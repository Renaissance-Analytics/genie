import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * v60 must survive a database that actually HOLDS a marked collision.
 *
 * FOUND BY RUNNING THE LADDER AGAINST A COPY OF THE LIVE DATABASE, which is the
 * only place it reproduces. Every existing migration test builds its fixture on
 * a FRESH database, where no row is ever marked, so all 6659 of them pass while
 * the upgrade is broken on the one machine that matters.
 *
 * The failure:
 *
 *     SqliteError: UNIQUE constraint failed:
 *       workspace_agents.workspace_id, workspace_agents.name
 *
 * v55 left `idx_workspace_agents_name` — UNIQUE (workspace_id, name) WHERE
 * `collision_group IS NULL` — plus a `collision_group` mark on every pair that
 * clashed on the way down. The mark is what keeps a colliding row OUT of that
 * partial index.
 *
 * v60 begins by clearing every mark in one statement, and only afterwards drops
 * the old index. Between those two, both halves of a marked pair are unmarked
 * and the narrow index is still live, so they collide instantly and the whole
 * upgrade transaction dies. The migration's own comment describes the right
 * sequence — *"marks are cleared first, and only re-applied to rows that still
 * clash under the WIDER key"* — the statements were simply ordered wrong.
 *
 * Measured on the live workstation: `codex:moic-slave` and `genie:moic-slave`
 * in one workspace, marked, exactly the pair v60 exists to dissolve. Under the
 * wider (workspace, tui, name) key they are two agents and the collision stops
 * existing — which is the whole point, and it never got the chance to happen.
 */

/** A database in the v59 state, holding a marked collision like the real one. */
function atV59WithMarkedCollision(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    db.prepare(
        `INSERT INTO workspaces
           (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
            shape, path, last_opened_at, created_by_genie)
         VALUES ('ws', 'tynn', 'p', 'W', 'p', 'W', 'simple', '/tmp/ws', null, 0)`,
    ).run();

    // Put the schema back to what v55 left: the NARROW partial key.
    db.exec(`
        DROP INDEX IF EXISTS idx_workspace_agents_tui_name;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agents_name
            ON workspace_agents(workspace_id, name) WHERE collision_group IS NULL;
    `);

    // The colliding pair, both MARKED — which is the only reason the narrow
    // index tolerates them.
    const insert = db.prepare(
        `INSERT INTO workspace_agents
           (id, workspace_id, tui, name, purpose, role, collision_group, created_at, updated_at)
         VALUES (?, 'ws', ?, 'moic-slave', '', 'specialized', ?, 1, 1)`,
    );
    insert.run('a-codex', 'codex', 'ws:codex:moic-slave');
    insert.run('a-genie', 'genie', 'ws:genie:moic-slave');

    db.prepare('DELETE FROM schema_version WHERE version >= 60').run();
    return db;
}

describe('v60 upgrades a database that holds a marked collision', () => {
    it('does not die on the UNIQUE key the marks were hiding the pair from', () => {
        const db = atV59WithMarkedCollision();

        expect(() => runMigrations(db)).not.toThrow();
    });

    it('keeps BOTH agents — the pair is dissolved, not resolved by deletion', () => {
        // The point of the wider key: under (workspace, tui, name) these are two
        // agents. Nothing has to be picked, renamed or dropped.
        const db = atV59WithMarkedCollision();

        runMigrations(db);

        const rows = db
            .prepare<[], { id: string; tui: string }>(
                'SELECT id, tui FROM workspace_agents ORDER BY id',
            )
            .all();
        expect(rows).toEqual([
            { id: 'a-codex', tui: 'codex' },
            { id: 'a-genie', tui: 'genie' },
        ]);
    });

    it('clears the marks, because the pair no longer clashes', () => {
        // A mark left behind would keep both rows OUT of the new unique index
        // forever — the escape hatch outliving the thing it was escaping.
        const db = atV59WithMarkedCollision();

        runMigrations(db);

        const marked = db
            .prepare<[], { c: number }>(
                'SELECT COUNT(*) c FROM workspace_agents WHERE collision_group IS NOT NULL',
            )
            .get()!;
        expect(marked.c).toBe(0);
    });

    it('still refuses a REAL duplicate under the wider key', () => {
        // POSITIVE CONTROL. Dropping the old index and never building the new one
        // would satisfy every assertion above, and silently remove the guarantee
        // v60 exists to provide.
        const db = atV59WithMarkedCollision();
        runMigrations(db);

        expect(() =>
            db
                .prepare(
                    `INSERT INTO workspace_agents
                       (id, workspace_id, tui, name, purpose, role, created_at, updated_at)
                     VALUES ('a-dupe', 'ws', 'codex', 'moic-slave', '', 'specialized', 1, 1)`,
                )
                .run(),
        ).toThrow(/UNIQUE/i);
    });
});
