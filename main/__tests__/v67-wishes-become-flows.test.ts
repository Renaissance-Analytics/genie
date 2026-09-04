import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * v67 — WISHES BECOME FLOWS, AND THE GAPP CANVAS STEPS ASIDE (genie#394).
 *
 * Genie's automation system is called Flows. The module that shipped in
 * `v0.7.0-beta.298` under the name Wishes IS that system, so its table is
 * renamed to `flows`. The name was already taken by v47's table of fancy-flow
 * canvas graphs owned by a Genie App, which is the narrower thing — one GApp's
 * workflows — so it becomes `gapp_flows` and frees the general name.
 *
 * Two renames in one migration, and the ORDER matters: `flows` must vacate
 * before `wishes` can take the name.
 *
 * ## The scope ladder collapses to three
 *
 * A stored scope is JSON in `scope_json`, so the words in it are data and a
 * rename of the type does not move them. The ladder becomes
 * **system / workspace / gapp**, and `exposure` is gone — a `gapp`-scoped Flow
 * IS internal to its GApp, which is what the field's `'internal'` value said.
 *
 * The value that has nowhere else to go is `exposure: 'workstation'` — a GApp's
 * Flow that appeared workstation-wide. Under three scopes the thing that is
 * visible workstation-wide is `system`, so that is where it lands. What it
 * loses is the `appId` it carried, which bought nothing: v66 deliberately
 * declined the app foreign key and the uninstall cascade `flows` had, so no
 * behaviour anywhere read that id. Narrowing it to `gapp` instead would HIDE a
 * Flow its author published; widening to `system` keeps it exactly as visible
 * as it was.
 */

/**
 * A database rewound to the v66 world: `wishes` holding Flow definitions,
 * `flows` holding GApp canvas graphs, and v67 not yet applied.
 *
 * Built by migrating fully and then undoing v67, rather than by hand-writing
 * the old schema — a hand-written copy can drift from what v47 and v66 actually
 * created, and then the test proves the migration works on a table no user has.
 */
function preV67(): Database.Database {
    const d = new Database(':memory:');
    runMigrations(d);
    d.exec(`
        DROP INDEX IF EXISTS idx_flows_purpose;
        DROP INDEX IF EXISTS idx_gapp_flows_app;
        ALTER TABLE flows RENAME TO wishes;
        ALTER TABLE gapp_flows RENAME TO flows;
        CREATE INDEX IF NOT EXISTS idx_wishes_purpose ON wishes(purpose);
        CREATE INDEX IF NOT EXISTS idx_flows_app ON flows(app_id);
    `);
    d.prepare('DELETE FROM schema_version WHERE version >= 67').run();
    return d;
}

function tables(d: Database.Database): Set<string> {
    return new Set(
        d
            .prepare<[], { name: string }>(
                `SELECT name FROM sqlite_master WHERE type = 'table'`,
            )
            .all()
            .map((r) => r.name),
    );
}

function indexes(d: Database.Database): Set<string> {
    return new Set(
        d
            .prepare<[], { name: string }>(
                `SELECT name FROM sqlite_master WHERE type = 'index'`,
            )
            .all()
            .map((r) => r.name),
    );
}

function wish(
    d: Database.Database,
    id: string,
    scope: Record<string, unknown>,
): void {
    d.prepare(
        `INSERT INTO wishes (id, title, purpose, description, scope_json, triggers_json,
                             recipe_json, enabled, created_at, updated_at)
         VALUES (?, ?, 'tidying', NULL, ?, '[{"kind":"manual"}]',
                 '{"kind":"builtin","recipeId":"r"}', 1, datetime('now'), datetime('now'))`,
    ).run(id, `title ${id}`, JSON.stringify(scope));
}

function storedScope(d: Database.Database, id: string): unknown {
    const row = d
        .prepare<[string], { scope_json: string }>(
            'SELECT scope_json FROM flows WHERE id = ?',
        )
        .get(id);
    return row ? JSON.parse(row.scope_json) : null;
}

describe('v67 renames the tables', () => {
    it('gives `flows` to the Flow definitions and `gapp_flows` to the canvas graphs', () => {
        const d = preV67();
        runMigrations(d);

        const t = tables(d);
        expect(t.has('wishes')).toBe(false);
        expect(t.has('flows')).toBe(true);
        expect(t.has('gapp_flows')).toBe(true);

        // Not just the names — the right table under each name. A rename that
        // swapped them would satisfy the assertions above.
        const flowCols = new Set(
            d.prepare<[], { name: string }>('PRAGMA table_info(flows)').all().map((r) => r.name),
        );
        expect(flowCols.has('scope_json')).toBe(true);
        expect(flowCols.has('graph_json')).toBe(false);

        const gappCols = new Set(
            d
                .prepare<[], { name: string }>('PRAGMA table_info(gapp_flows)')
                .all()
                .map((r) => r.name),
        );
        expect(gappCols.has('graph_json')).toBe(true);
        expect(gappCols.has('app_id')).toBe(true);
    });

    it('renames the indexes with their tables', () => {
        const d = preV67();
        runMigrations(d);

        const i = indexes(d);
        expect(i.has('idx_flows_purpose')).toBe(true);
        expect(i.has('idx_gapp_flows_app')).toBe(true);
        expect(i.has('idx_wishes_purpose')).toBe(false);
        expect(i.has('idx_flows_app')).toBe(false);
    });

    it('carries the rows across — a rename, not a fresh table', () => {
        const d = preV67();
        wish(d, 'w-1', { kind: 'workspace', workspaceId: 'ws-1' });
        d.prepare(
            `INSERT INTO app_grants (app_id, workspace_id, name, version, slug, scope, manifest_json,
                                     install_path, installed_at, updated_at)
             VALUES ('trader','ws-1','Trader','1.0.0','trader','self','{}','/tmp/app','','')`,
        ).run();
        d.prepare(
            `INSERT INTO flows (id, app_id, name, graph_json, enabled, created_at, updated_at)
             VALUES ('f-1', 'trader', 'nightly', '{"nodes":[]}', 1, datetime('now'), datetime('now'))`,
        ).run();

        runMigrations(d);

        expect(
            d.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM flows').get()?.n,
        ).toBe(1);
        expect(
            d.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM gapp_flows').get()?.n,
        ).toBe(1);
    });

    it('keeps the GApp canvas rows readable under the new name', () => {
        const d = preV67();
        d.prepare(
            `INSERT INTO app_grants (app_id, workspace_id, name, version, slug, scope, manifest_json,
                                     install_path, installed_at, updated_at)
             VALUES ('trader','ws-1','Trader','1.0.0','trader','self','{}','/tmp/app','','')`,
        ).run();
        d.prepare(
            `INSERT INTO flows (id, app_id, name, graph_json, enabled, created_at, updated_at)
             VALUES ('f-1', 'trader', 'nightly', '{"nodes":[]}', 1, datetime('now'), datetime('now'))`,
        ).run();

        runMigrations(d);

        const row = d
            .prepare<[string], { name: string; graph_json: string }>(
                'SELECT name, graph_json FROM gapp_flows WHERE id = ?',
            )
            .get('f-1');
        expect(row?.name).toBe('nightly');
        expect(row?.graph_json).toBe('{"nodes":[]}');
    });
});

describe('v67 collapses the scope ladder to system / workspace / gapp', () => {
    it('turns a workstation scope into a system scope', () => {
        const d = preV67();
        wish(d, 'w-station', { kind: 'workstation' });

        runMigrations(d);

        expect(storedScope(d, 'w-station')).toEqual({ kind: 'system' });
    });

    it('turns an internal app scope into a gapp scope and drops exposure', () => {
        const d = preV67();
        wish(d, 'w-internal', { kind: 'app', appId: 'trader', exposure: 'internal' });

        runMigrations(d);

        expect(storedScope(d, 'w-internal')).toEqual({ kind: 'gapp', appId: 'trader' });
    });

    it('turns a workstation-EXPOSED app scope into a system scope, not a hidden gapp one', () => {
        // The one value the three-scope ladder has no direct slot for. It was
        // visible workstation-wide; `system` is what that means now. Landing it
        // on `gapp` would hide a Flow its author published.
        const d = preV67();
        wish(d, 'w-exposed', { kind: 'app', appId: 'trader', exposure: 'workstation' });

        runMigrations(d);

        expect(storedScope(d, 'w-exposed')).toEqual({ kind: 'system' });
    });

    it('leaves a workspace scope exactly as it was', () => {
        // POSITIVE CONTROL: a migration that rewrote every row to `system`
        // would pass the first case above. This one says it did not.
        const d = preV67();
        wish(d, 'w-ws', { kind: 'workspace', workspaceId: 'ws-7' });

        runMigrations(d);

        expect(storedScope(d, 'w-ws')).toEqual({ kind: 'workspace', workspaceId: 'ws-7' });
    });

    it('leaves a row nobody can parse alone rather than losing it', () => {
        // A hand-edited or half-written row is not a reason to delete a Flow.
        // `store.ts` already refuses to return it; the migration must not make
        // that decision permanent by dropping the row.
        const d = preV67();
        d.prepare(
            `INSERT INTO wishes (id, title, purpose, description, scope_json, triggers_json,
                                 recipe_json, enabled, created_at, updated_at)
             VALUES ('w-broken', 't', 'tidying', NULL, 'not json', '[]', '{}', 1,
                     datetime('now'), datetime('now'))`,
        ).run();

        runMigrations(d);

        expect(
            d
                .prepare<[string], { scope_json: string }>(
                    'SELECT scope_json FROM flows WHERE id = ?',
                )
                .get('w-broken')?.scope_json,
        ).toBe('not json');
    });

    it('is idempotent — re-running converges without throwing', () => {
        const d = preV67();
        wish(d, 'w-station', { kind: 'workstation' });
        runMigrations(d);
        expect(() => runMigrations(d)).not.toThrow();
        expect(storedScope(d, 'w-station')).toEqual({ kind: 'system' });
    });
});
