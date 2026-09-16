import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
    hibernatedWorkspaceIdsIn,
    isWorkspaceHibernatedIn,
    runMigrations,
    setWorkspaceHibernatedIn,
} from '../../db';

/**
 * A hibernated workspace STAYS hibernated (genie#672).
 *
 * The owner: "Hibernated workspaces have all processes and terminals completely
 * shut down and do not wake up after upgrades or restarts, only when a user
 * manually wakes them up." So the state lives in the database — machine-local,
 * like a site the user stopped (genie#407), and not in the git-tracked envelope —
 * where every boot path can ask it.
 */

const V_BEFORE = 77;

function plantWorkspace(db: Database.Database, id: string): void {
    db.prepare(
        `INSERT INTO workspaces (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
                                 shape, path, created_by_genie)
         VALUES (@id, 'tynn', @id, @id, @id, @id, 'agi', @path, 1)`,
    ).run({ id, path: `/work/${id}` });
}

describe('the hibernation flag', () => {
    it('is added by a migration, and a workspace that existed before it is awake', () => {
        const db = new Database(':memory:');
        runMigrations(db, { upTo: V_BEFORE });
        plantWorkspace(db, 'ws-old');
        runMigrations(db);

        const columns = (db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>).map((c) => c.name);
        expect(columns).toContain('hibernated_at');
        expect(isWorkspaceHibernatedIn(db, 'ws-old')).toBe(false);
    });

    it('is set, read, listed and cleared', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        plantWorkspace(db, 'ws-a');
        plantWorkspace(db, 'ws-b');

        setWorkspaceHibernatedIn(db, 'ws-a', true, 1_789_000_000_000);
        expect(isWorkspaceHibernatedIn(db, 'ws-a')).toBe(true);
        // Control: the neighbour is untouched.
        expect(isWorkspaceHibernatedIn(db, 'ws-b')).toBe(false);
        expect(hibernatedWorkspaceIdsIn(db)).toEqual(['ws-a']);
        const row = db.prepare('SELECT hibernated_at FROM workspaces WHERE id = ?').get('ws-a') as {
            hibernated_at: number;
        };
        expect(row.hibernated_at).toBe(1_789_000_000_000);

        setWorkspaceHibernatedIn(db, 'ws-a', false);
        expect(isWorkspaceHibernatedIn(db, 'ws-a')).toBe(false);
        expect(hibernatedWorkspaceIdsIn(db)).toEqual([]);
    });

    it('reads an unknown workspace as awake', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        expect(isWorkspaceHibernatedIn(db, 'nope')).toBe(false);
    });
});
