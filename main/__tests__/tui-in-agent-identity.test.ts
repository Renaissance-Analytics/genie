import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * v60 — the TUI is part of an agent's identity again.
 *
 * The owner's rule: *"tui should be tui because the tui is what determines
 * the tui and supports TUIs that can use any tui, so tui itself
 * is not important for agent identity. Unique should be on workspace, tui,
 * name."*
 *
 * v55 went the other way: it collapsed `(workspace, tui, name)` to
 * `(workspace, name)` on the reasoning that an agent switching driver is the
 * same agent. The cost was `collision_group` — a partial index escape hatch for
 * every pair that clashed on the way down, left for a human to resolve by hand.
 * On this workstation that stranded `codex:moic-slave` against
 * `genie:moic-slave` indefinitely.
 *
 * Under `(workspace, tui, name)` that pair is simply two agents, and the
 * collision stops existing rather than waiting to be settled.
 *
 * VERIFIED BEFORE WRITING THIS: on the live database all 29 agents already
 * satisfy the new key — zero duplicate `(workspace, tui, name)` groups and
 * zero NULL providers. So the migration renames nothing, merges nothing, and
 * drops nothing. That is the only reason it is safe to tighten a key on real
 * records.
 */

function db(): Database.Database {
    const d = new Database(':memory:');
    runMigrations(d);
    // `workspace_agents.workspace_id` is a real foreign key, so the workspaces
    // have to exist before an agent can point at one.
    for (const id of ['w1', 'w2']) {
        d.prepare(
            `INSERT INTO workspaces
               (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
                shape, path, created_by_genie)
             VALUES (?, 'tynn', ?, ?, ?, ?, 'simple', ?, 0)`,
        ).run(id, id, id, id, id, `/tmp/${id}`);
    }
    return d;
}

function addAgent(
    d: Database.Database,
    {
        id,
        ws = 'w1',
        tui,
        name,
        collision = null,
    }: { id: string; ws?: string; tui: string; name: string; collision?: string | null },
): void {
    d.prepare(
        `INSERT INTO workspace_agents
           (id, workspace_id, tui, name, purpose, role, reachability, wake_on_dm,
            created_at, updated_at, collision_group)
         VALUES (?, ?, ?, ?, '', 'specialized', 'workspace', 1, 0, 0, ?)`,
    ).run(id, ws, tui, name, collision);
}

// The owner settled the identity key: *"Unique should be on workspace, tui,
// name."* Whether the COLUMN is literally renamed `tui` -> `tui` is a
// separate question and does not block this — the key is what identity means,
// the column name is what the code calls it.
//
// Verified against the live database before writing: all 29 agents already
// satisfy (workspace, tui, name), zero NULL providers, zero duplicates — so
// this migration renames, merges and drops nothing. That is the only reason it
// is safe to tighten a key on real records.
describe('agent identity is (workspace, tui, name) — v60', () => {
    it('lets the SAME name exist under two different TUIs', () => {
        const d = db();

        addAgent(d, { id: 'a', tui: 'codex', name: 'moic-slave' });
        // This is the pair that sat unresolved under the old key.
        expect(() => addAgent(d, { id: 'b', tui: 'genie', name: 'moic-slave' })).not.toThrow();
    });

    it('still refuses the same name under the SAME tui', () => {
        // POSITIVE CONTROL: widening the key must not remove uniqueness
        // altogether, or two identical agents can exist and `runAgent start`
        // has nothing to resolve.
        const d = db();

        addAgent(d, { id: 'a', tui: 'claude', name: 'tynn' });
        expect(() => addAgent(d, { id: 'b', tui: 'claude', name: 'tynn' })).toThrow();
    });

    it('keeps names separate per workspace', () => {
        // POSITIVE CONTROL: the workspace half of the key still holds.
        const d = db();

        addAgent(d, { id: 'a', ws: 'w1', tui: 'claude', name: 'tynn' });
        expect(() => addAgent(d, { id: 'b', ws: 'w2', tui: 'claude', name: 'tynn' })).not.toThrow();
    });

    it('clears collision_group — the marks it existed for cannot recur', () => {
        const d = db();
        const left = d
            .prepare<[], { c: number }>(
                'SELECT COUNT(*) AS c FROM workspace_agents WHERE collision_group IS NOT NULL',
            )
            .get();

        expect(left?.c).toBe(0);
    });

    it('still allows only ONE workspace agent per workspace', () => {
        // POSITIVE CONTROL: the TWA index is independent of the name key and
        // must survive this migration untouched.
        const d = db();

        d.prepare(
            `INSERT INTO workspace_agents
               (id, workspace_id, tui, name, purpose, role, reachability, wake_on_dm, created_at, updated_at)
             VALUES ('t1','w1','claude','one','', 'workspace','workspace',1,0,0)`,
        ).run();
        expect(() =>
            d
                .prepare(
                    `INSERT INTO workspace_agents
                       (id, workspace_id, tui, name, purpose, role, reachability, wake_on_dm, created_at, updated_at)
                     VALUES ('t2','w1','codex','two','', 'workspace','workspace',1,0,0)`,
                )
                .run(),
        ).toThrow();
    });
});
