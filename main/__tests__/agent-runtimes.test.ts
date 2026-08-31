import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { backfillRuntimes, runMigrations } from '../db';

/**
 * v55 — an Agent is no longer bound to the TUI driving it.
 *
 * `UNIQUE (workspace_id, provider, name)` made the TUI part of an agent's
 * IDENTITY: `claude:tynn` and `codex:tynn` were two agents, and switching driver
 * meant becoming someone else. `UNIQUE (terminal_spec_id)` on the same table
 * allowed at most ONE terminal per agent, which forbids sidecars outright.
 *
 * So the record splits. `workspace_agents` keeps identity — name, purpose,
 * scope, persona — and `agent_runtimes` holds each TUI it may run under, at most
 * one of them fronted. `workspace_agents.terminal_spec_id` deliberately stays as
 * a cached mirror of the fronted runtime: a great deal of code reads it, and
 * staging the migration is what keeps this from being a flag day.
 *
 * COLLISIONS ARE NOT RESOLVED HERE. Collapsing `(workspace, provider, name)` to
 * `(workspace, name)` collides wherever a workspace holds `claude:general` AND
 * `codex:general`, and the owner decides which survives — from previews of the
 * real terminals, not from a rule this migration invented on an unattended host.
 * Colliding rows are MARKED and left intact, and the name index is partial so
 * they can coexist until the question is answered.
 */

function cols(db: Database.Database, table: string): Set<string> {
    return new Set(
        db
            .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
            .all()
            .map((r) => r.name),
    );
}

function seedWorkspace(db: Database.Database, wsId: string): void {
    db.prepare(
        `INSERT INTO workspaces
           (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
            shape, path, last_opened_at, created_by_genie)
         VALUES (?, 'tynn', ?, 'W', ?, 'W', 'simple', ?, null, 0)`,
    ).run(wsId, `p-${wsId}`, `p-${wsId}`, `/tmp/${wsId}`);
}

function addAgent(
    db: Database.Database,
    row: { id: string; ws: string; provider?: string | null; name: string; spec?: string | null },
): void {
    db.prepare(
        `INSERT INTO workspace_agents
           (id, workspace_id, provider, name, purpose, role, terminal_spec_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', 'specialized', ?, 1, 1)`,
    ).run(row.id, row.ws, row.provider ?? null, row.name, row.spec ?? null);
}

function addRuntime(
    db: Database.Database,
    row: { id: string; agent: string; provider: string; spec?: string | null; fronted?: number },
): void {
    db.prepare(
        `INSERT INTO agent_runtimes
           (id, agent_id, provider, terminal_spec_id, fronted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 1)`,
    ).run(row.id, row.agent, row.provider, row.spec ?? null, row.fronted ?? 0);
}

function fresh(): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
}

describe('v55 — the runtimes table', () => {
    it('exists, with the columns a sidecar needs', () => {
        const columns = cols(fresh(), 'agent_runtimes');
        for (const column of [
            'agent_id',
            'provider',
            'terminal_spec_id',
            'chat_session_id',
            'fronted',
        ]) {
            expect(columns.has(column), column).toBe(true);
        }
    });

    it('lets ONE agent hold runtimes for several TUIs', () => {
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a1', ws: 'ws-1', name: 'tynn' });

        addRuntime(db, { id: 'r1', agent: 'a1', provider: 'claude', fronted: 1 });
        addRuntime(db, { id: 'r2', agent: 'a1', provider: 'codex' });

        expect(
            db
                .prepare<[string], { c: number }>(
                    'SELECT COUNT(*) AS c FROM agent_runtimes WHERE agent_id = ?',
                )
                .get('a1')!.c,
        ).toBe(2);
    });

    it('allows only ONE fronted runtime per agent', () => {
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a1', ws: 'ws-1', name: 'tynn' });
        addRuntime(db, { id: 'r1', agent: 'a1', provider: 'claude', fronted: 1 });

        // Two visible TUIs for one agent is not a state the UI can render, and
        // flipping between them is a swap, not an add.
        expect(() =>
            addRuntime(db, { id: 'r2', agent: 'a1', provider: 'codex', fronted: 1 }),
        ).toThrow();
    });

    it('allows one runtime per TUI per agent', () => {
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a1', ws: 'ws-1', name: 'tynn' });
        addRuntime(db, { id: 'r1', agent: 'a1', provider: 'claude' });

        expect(() =>
            addRuntime(db, { id: 'r2', agent: 'a1', provider: 'claude' }),
        ).toThrow();
    });

    it('keeps one terminal spec from backing two runtimes', () => {
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a1', ws: 'ws-1', name: 'one' });
        addAgent(db, { id: 'a2', ws: 'ws-1', name: 'two' });
        db.prepare(
            `INSERT INTO terminal_specs
               (id, workspace_id, label, cwd, type, meta_json, sort_order, created_at)
             VALUES ('t1', 'ws-1', 'l', '/tmp', 'terminal', '{}', 0, 1)`,
        ).run();

        addRuntime(db, { id: 'r1', agent: 'a1', provider: 'claude', spec: 't1' });
        expect(() =>
            addRuntime(db, { id: 'r2', agent: 'a2', provider: 'claude', spec: 't1' }),
        ).toThrow();
    });

    it('leaves runtimes behind when their agent is deleted', () => {
        // POSITIVE CONTROL on the cascade: without it, deleting an agent would
        // strand rows that still claim its terminal spec, and the spec index
        // would then refuse the next agent that legitimately wanted it.
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a1', ws: 'ws-1', name: 'tynn' });
        addRuntime(db, { id: 'r1', agent: 'a1', provider: 'claude' });
        db.prepare('PRAGMA foreign_keys = ON').run();

        db.prepare('DELETE FROM workspace_agents WHERE id = ?').run('a1');

        expect(
            db
                .prepare<[string], { c: number }>(
                    'SELECT COUNT(*) AS c FROM agent_runtimes WHERE agent_id = ?',
                )
                .get('a1')!.c,
        ).toBe(0);
    });
});

describe('v55 — identity is (workspace, name)', () => {
    it('refuses a second agent under the same NAME, whatever TUI it names', () => {
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        addAgent(db, { id: 'a1', ws: 'ws-1', provider: 'claude', name: 'tynn' });

        // Legal under the old key — a different provider made it a different
        // agent. That is precisely the model being removed.
        expect(() =>
            addAgent(db, { id: 'a2', ws: 'ws-1', provider: 'codex', name: 'tynn' }),
        ).toThrow();
    });

    it('still allows the same name in DIFFERENT workspaces', () => {
        const db = fresh();
        seedWorkspace(db, 'ws-1');
        seedWorkspace(db, 'ws-2');
        addAgent(db, { id: 'a1', ws: 'ws-1', name: 'general' });

        expect(() => addAgent(db, { id: 'a2', ws: 'ws-2', name: 'general' })).not.toThrow();
    });
});

describe('v55 — migrating a profile that already has agents', () => {
    /** A pre-v55 database: schema up to v54, with rows written the way v50 wrote them. */
    function preV55(rows: Array<{ id: string; provider: string; name: string; spec?: string }>) {
        const db = new Database(':memory:');
        runMigrations(db);
        // Undo the v55 shape so the migration has something to do, then re-run it.
        db.prepare('DROP INDEX IF EXISTS idx_workspace_agents_name').run();
        db.prepare('DELETE FROM agent_runtimes').run();
        seedWorkspace(db, 'ws-1');
        for (const r of rows) {
            if (r.spec) {
                db.prepare(
                    `INSERT INTO terminal_specs
                       (id, workspace_id, label, cwd, type, meta_json, sort_order, created_at)
                     VALUES (?, 'ws-1', 'l', '/tmp', 'terminal', '{}', 0, 1)`,
                ).run(r.spec);
            }
            addAgent(db, { id: r.id, ws: 'ws-1', provider: r.provider, name: r.name, spec: r.spec });
        }
        return db;
    }

    it('gives each existing agent a fronted runtime carrying its TUI and terminal', () => {
        const db = preV55([{ id: 'a1', provider: 'claude', name: 'tynn', spec: 't1' }]);

        backfillRuntimes(db);

        const runtime = db
            .prepare<[string], { provider: string; terminal_spec_id: string | null; fronted: number }>(
                'SELECT provider, terminal_spec_id, fronted FROM agent_runtimes WHERE agent_id = ?',
            )
            .get('a1');
        expect(runtime).toMatchObject({ provider: 'claude', terminal_spec_id: 't1', fronted: 1 });
    });

    it('marks a NAME collision instead of picking a winner', () => {
        // `claude:general` and `codex:general` were two legal agents. Collapsing
        // the key makes them one name, and which conversation survives is the
        // owner's call — so both rows stay, flagged, until they answer.
        const db = preV55([
            { id: 'a1', provider: 'claude', name: 'general' },
            { id: 'a2', provider: 'codex', name: 'general' },
        ]);

        backfillRuntimes(db);

        const marked = db
            .prepare<[string], { id: string; collision_group: string | null }>(
                'SELECT id, collision_group FROM workspace_agents WHERE name = ? ORDER BY id',
            )
            .all('general');
        expect(marked).toHaveLength(2);
        expect(marked[0]!.collision_group).toBeTruthy();
        expect(marked[0]!.collision_group).toBe(marked[1]!.collision_group);
    });

    it('leaves an uncontested agent unmarked', () => {
        // POSITIVE CONTROL: "collision_group is set" would pass against a
        // migration that marked every row, which would put the whole estate
        // behind a resolution prompt.
        const db = preV55([{ id: 'a1', provider: 'claude', name: 'tynn' }]);

        backfillRuntimes(db);

        expect(
            db
                .prepare<[string], { collision_group: string | null }>(
                    'SELECT collision_group FROM workspace_agents WHERE id = ?',
                )
                .get('a1')!.collision_group,
        ).toBeNull();
    });

    it('lets marked collisions coexist under the name index', () => {
        // The index is partial for exactly this reason: a UNIQUE(workspace,name)
        // that could not tolerate them would fail the migration outright and
        // block the upgrade on an unattended host.
        const db = preV55([
            { id: 'a1', provider: 'claude', name: 'general' },
            { id: 'a2', provider: 'codex', name: 'general' },
        ]);

        expect(() => backfillRuntimes(db)).not.toThrow();
    });
});
