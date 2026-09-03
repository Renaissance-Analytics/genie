import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
    ensureSystemWorkspaceRow,
    listWorkspacesIn,
    removeWorkspaceIn,
    runMigrations,
    SYSTEM_WORKSPACE_ROW_ID,
} from '../db';

/**
 * The System Workspace is a REAL row now.
 *
 * It used to be a sentinel with no row behind it — `workspace_id: null` +
 * `meta.system === true`, with every surface substituting `__system__` on the
 * way past. AgentInbox identity is `workspaceId:purpose`, so the workspace is
 * half the operator's primary key: with no row it had no identity, and the
 * substitutions were the only thing holding the illusion together. Each one was
 * a place someone had to remember, and five of them were found broken in a day.
 *
 * PROTECTED means three things, and all three are structural rather than a
 * filter repeated per surface:
 *   - it is not in `listWorkspaces()`, which is what every picker, sidebar and
 *     per-workspace reconcile enumerates — so nothing offers it, polls it, or
 *     starts a container in it;
 *   - `removeWorkspace` refuses it, so `manageWorkspaces remove` cannot unmount
 *     the machine's own operator;
 *   - it is rooted at `~/.gosa`, outside `userData`, so Reset Workstation
 *     cannot reach its files at all.
 *
 * It is still reachable by id — `getWorkspace('__system__')` — which is the
 * whole point: every guard that reads a workspace row now finds one.
 */

function fresh(): Database.Database {
    // `runMigrations` is what `initDatabase` applies, so the row helpers are
    // exercised against exactly the schema production gets.
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
}

function seedOrdinary(db: Database.Database, id: string): void {
    db.prepare(
        `INSERT INTO workspaces
           (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
            shape, path, last_opened_at, created_by_genie)
         VALUES (?, 'tynn', ?, 'Ordinary', ?, 'Ordinary', 'agi', ?, null, 0)`,
    ).run(id, `p-${id}`, `p-${id}`, `/src/${id}`);
}

describe('the protected System Workspace row', () => {
    it('exists, at the operator root, under the id every surface already uses', () => {
        const db = fresh();

        const row = ensureSystemWorkspaceRow(db, '/home/wishborn/.gosa');

        expect(row.id).toBe(SYSTEM_WORKSPACE_ROW_ID);
        expect(SYSTEM_WORKSPACE_ROW_ID).toBe('__system__');
        expect(row.path).toBe('/home/wishborn/.gosa');
    });

    it('is the workstation operator, so its agent may act on every workspace', () => {
        const db = fresh();

        expect(ensureSystemWorkspaceRow(db, '/home/w/.gosa').workstation_operator).toBe(1);
    });

    it('follows the root when the home directory changes', () => {
        const db = fresh();
        ensureSystemWorkspaceRow(db, '/old/.gosa');

        expect(ensureSystemWorkspaceRow(db, '/new/.gosa').path).toBe('/new/.gosa');
    });

    it('is NOT offered by the workspace list every picker enumerates', () => {
        const db = fresh();
        ensureSystemWorkspaceRow(db, '/home/w/.gosa');
        seedOrdinary(db, 'ws-1');

        expect(listWorkspacesIn(db).map((w) => w.id)).toEqual(['ws-1']);
    });

    it('refuses to be unregistered', () => {
        const db = fresh();
        ensureSystemWorkspaceRow(db, '/home/w/.gosa');

        expect(() => removeWorkspaceIn(db, SYSTEM_WORKSPACE_ROW_ID)).toThrow(
            /system workspace/i,
        );
        expect(
            db.prepare('SELECT count(*) AS n FROM workspaces WHERE id = ?')
                .get(SYSTEM_WORKSPACE_ROW_ID),
        ).toEqual({ n: 1 });
    });

    it('POSITIVE CONTROL — an ordinary workspace is listed and can still be removed', () => {
        // The single most important assertion here. "The operator works" passes
        // just as well against a change that quietly protected or hid every
        // workspace on the machine.
        const db = fresh();
        ensureSystemWorkspaceRow(db, '/home/w/.gosa');
        seedOrdinary(db, 'ws-1');

        expect(listWorkspacesIn(db).map((w) => w.id)).toEqual(['ws-1']);
        expect(() => removeWorkspaceIn(db, 'ws-1')).not.toThrow();
        expect(listWorkspacesIn(db)).toEqual([]);
    });
});
