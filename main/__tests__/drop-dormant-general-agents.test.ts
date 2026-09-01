import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * v62 — the DORMANT `general` agents are removed (Tynn story #262).
 *
 * `general` was never a name anyone chose. `normalizePurpose` returned it for
 * any agent that joined without a stated purpose, so an unnamed terminal became
 * `{tui}:general`. On this workstation that left **7 of 29 agents** called
 * `general` across seven workspaces, none deliberately created.
 *
 * #326 stopped Genie inventing them and the reserved-name block list stops one
 * being typed back in. This clears the rows that are already there.
 *
 * ONLY THE DORMANT ONES GO, which is the owner's instruction and also the only
 * safe rule. Measured on the live database before this was written: of the 7,
 * **three hold a live terminal spec** (Fancy Docs, Impact Hub, Prism) and **four
 * hold none** (Civicognita Operations, Impactopia, Renaissance Analytics
 * Operations, Wish's Wonders Operations). Deleting a row that owns a terminal
 * would strand the terminal — the same hazard v57 called out.
 *
 * INERTNESS IS TESTED THROUGH THE RUNTIME, not just `workspace_agents`. v55
 * moved terminal binding onto `agent_runtimes`, so an agent whose own
 * `terminal_spec_id` is NULL can still be driving a terminal through a runtime.
 * Checking only the legacy column would delete a live agent.
 */

function fresh(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
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

function seedSpec(db: Database.Database, id: string, ws: string): void {
    db.prepare(
        `INSERT INTO terminal_specs (id, workspace_id, label, cwd, created_at)
         VALUES (?, ?, 'T', '/tmp', '1')`,
    ).run(id, ws);
}

function addAgent(
    db: Database.Database,
    row: { id: string; ws: string; name: string; spec?: string | null },
): void {
    db.prepare(
        `INSERT INTO workspace_agents
           (id, workspace_id, provider, name, purpose, role, terminal_spec_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, '', 'specialized', ?, 1, 1)`,
    ).run(row.id, row.ws, row.name, row.spec ?? null);
}

function addRuntime(
    db: Database.Database,
    row: { id: string; agent: string; spec?: string | null },
): void {
    db.prepare(
        `INSERT INTO agent_runtimes (id, agent_id, provider, terminal_spec_id, fronted, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, 1, 1, 1)`,
    ).run(row.id, row.agent, row.spec ?? null);
}

/** Re-run the ladder from v62 so the migration under test replays. */
function replay(db: Database.Database): void {
    db.prepare('DELETE FROM schema_version WHERE version >= 62').run();
    runMigrations(db);
}

const names = (db: Database.Database) =>
    db
        .prepare<[], { name: string }>('SELECT name FROM workspace_agents ORDER BY id')
        .all()
        .map((r) => r.name);

describe('v62 — the dormant `general` agents are removed', () => {
    it('deletes a general agent that holds no terminal anywhere', () => {
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a-dormant', ws: 'ws-1', name: 'general' });
        addRuntime(db, { id: 'rt-dormant', agent: 'a-dormant', spec: null });

        replay(db);

        expect(names(db)).toEqual([]);
    });

    it('KEEPS a general agent that holds a terminal spec', () => {
        // Three of the seven on the live workstation are in exactly this state.
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        seedSpec(db, 'spec-live', 'ws-1');
        addAgent(db, { id: 'a-live', ws: 'ws-1', name: 'general', spec: 'spec-live' });

        replay(db);

        expect(names(db)).toEqual(['general']);
    });

    it('KEEPS a general agent whose RUNTIME holds the terminal', () => {
        // v55 moved terminal binding onto agent_runtimes. An agent whose own
        // legacy column is NULL can still be driving a terminal — deleting it
        // would strand that terminal.
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        seedSpec(db, 'spec-rt', 'ws-1');
        addAgent(db, { id: 'a-rt', ws: 'ws-1', name: 'general', spec: null });
        addRuntime(db, { id: 'rt-live', agent: 'a-rt', spec: 'spec-rt' });

        replay(db);

        expect(names(db)).toEqual(['general']);
    });

    it('POSITIVE CONTROL: leaves agents that are not named general', () => {
        // Without this, a migration that deleted every dormant agent would pass
        // every assertion above.
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a-other', ws: 'ws-1', name: 'tynn-builder' });

        replay(db);

        expect(names(db)).toEqual(['tynn-builder']);
    });

    it('matches the WHOLE name — `general-purpose` is a real agent', () => {
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a-gp', ws: 'ws-1', name: 'general-purpose' });

        replay(db);

        expect(names(db)).toEqual(['general-purpose']);
    });

    it('leaves no orphaned runtime behind', () => {
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a-dormant', ws: 'ws-1', name: 'general' });
        addRuntime(db, { id: 'rt-dormant', agent: 'a-dormant', spec: null });

        replay(db);

        const orphans = db
            .prepare<[], { c: number }>(
                `SELECT COUNT(*) AS c FROM agent_runtimes r
                  WHERE NOT EXISTS (SELECT 1 FROM workspace_agents a WHERE a.id = r.agent_id)`,
            )
            .get()!;
        expect(orphans.c).toBe(0);
    });

    it('is idempotent — re-running converges', () => {
        // TWO workspaces, because v60's UNIQUE (workspace_id, provider, name)
        // forbids two `general` agents on one provider in one workspace — which
        // is also why the live estate has exactly one per workspace.
        const db = fresh();
        seedWorkspace(db, 'ws-live');
        seedWorkspace(db, 'ws-dormant');
        seedSpec(db, 'spec-live', 'ws-live');
        addAgent(db, { id: 'a-live', ws: 'ws-live', name: 'general', spec: 'spec-live' });
        addAgent(db, { id: 'a-dormant', ws: 'ws-dormant', name: 'general' });

        replay(db);
        replay(db);

        expect(names(db)).toEqual(['general']);
    });
});
