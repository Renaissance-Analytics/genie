import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * v74 — ONE FLOWS SYSTEM. The canvas table takes the name back.
 *
 * ## What was true before this
 *
 * Genie had two automation systems and each had a table:
 *
 *  - `gapp_flows` — fancy-flow graphs owned by a Genie App (v47, renamed by
 *    v67). Real graphs, a real engine, a real editor.
 *  - `flows` — the RECIPE system that shipped as Wishes in beta.298 and was
 *    renamed to Flows by v67. A recipe id, a trigger list, a filter language,
 *    and a form of dropdowns to author it with.
 *
 * v67 gave the general name to the second one and demoted the first. This
 * reverses that, because the general system is the graph one: **a GApp flow is
 * a flow whose scope is `gapp`, not a separate kind of thing.** So there is one
 * table, and scope is a column on it.
 *
 * ## The recipe rows are DROPPED, not converted
 *
 * Stated plainly because it is the decision a reader will question. Every stored
 * recipe flow references `genie.relocate-file` — the only built-in body that
 * ever existed — and every one is born disarmed, with any edit to what it does
 * or where it acts disarming it again. So an armed row represents consent to a
 * body that will not exist after this migration.
 *
 * Rewriting that consent into a graph the user never saw would be worse than
 * dropping it: the arming decision was made against a sentence describing a
 * recipe, and the thing it would now be arming is a different artefact. The
 * equivalent flow ships as a TEMPLATE instead, so the decision is made again
 * against a body the author can actually read.
 *
 * ## `app_id` becomes nullable, and that is the whole scope story
 *
 * A `gapp`-scoped flow keeps the foreign key and the uninstall cascade — a
 * scheduled flow outliving its app is exactly what keeps firing after somebody
 * thought they had removed it. A `system` or `workspace` flow has no owning app,
 * so the column is null and the cascade cannot reach it.
 */

/**
 * A database exactly as v73 left it: `flows` holding recipe rows, `gapp_flows`
 * holding the canvas graphs.
 *
 * Stopped at 73 rather than migrated-then-undone. v74 DROPS the recipe table, so
 * there is no way to reconstruct it afterwards except by hand — and a
 * hand-written copy drifts from what v66 actually created, at which point the
 * test proves the migration works on a table no user has.
 */
function preV74(): Database.Database {
    const d = new Database(':memory:');
    runMigrations(d, { upTo: 73 });
    return d;
}

function tables(d: Database.Database): Set<string> {
    return new Set(
        d
            .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all()
            .map((r) => r.name),
    );
}

function columns(d: Database.Database, table: string): Map<string, { notnull: number }> {
    return new Map(
        d
            .prepare<[], { name: string; notnull: number }>(`PRAGMA table_info(${table})`)
            .all()
            .map((r) => [r.name, { notnull: r.notnull }] as const),
    );
}

function seedApp(d: Database.Database, appId: string): void {
    d.prepare(
        `INSERT INTO app_grants
            (app_id, workspace_id, name, version, slug, scope, workspaces_json,
             capabilities_json, manifest_json, install_path, revoked, installed_at, updated_at)
         VALUES (?, 'ws-1', ?, '1.0.0', 'app', 'self', '[]', '[]', '{}', '/tmp/app', 0,
                 '2026-01-01', '2026-01-01')`,
    ).run(appId, appId);
}

describe('after v74 there is one flows table', () => {
    it('gives the general name back to the graph system', () => {
        const d = preV74();
        expect(tables(d).has('gapp_flows')).toBe(true);

        runMigrations(d);

        const t = tables(d);
        expect(t.has('flows')).toBe(true);
        expect(t.has('gapp_flows')).toBe(false);
        expect(t.has('wishes')).toBe(false);
    });

    it('keeps the graphs a GApp already had, under the new name', () => {
        const d = preV74();
        seedApp(d, 'com.example.trader');
        d.prepare(
            `INSERT INTO gapp_flows (id, app_id, name, graph_json, enabled, created_at, updated_at)
             VALUES ('f1', 'com.example.trader', 'Nightly', '{"nodes":[],"edges":[]}', 1, '2026-01-01', '2026-01-01')`,
        ).run();

        runMigrations(d);

        const row = d
            .prepare<[], { id: string; app_id: string | null; scope_json: string; title: string }>(
                'SELECT id, app_id, scope_json, title FROM flows',
            )
            .get()!;
        expect(row.id).toBe('f1');
        expect(row.app_id).toBe('com.example.trader');
        // An app's existing graph becomes a `gapp`-scoped flow. Nothing else it
        // could honestly become: it was only ever visible inside that app.
        expect(JSON.parse(row.scope_json)).toEqual({
            kind: 'gapp',
            appId: 'com.example.trader',
        });
        // `title` is the general system's word; the canvas table called it `name`.
        expect(row.title).toBe('Nightly');
    });

    it('drops the recipe rows rather than converting consent it cannot carry', () => {
        const d = preV74();
        d.prepare(
            `INSERT INTO flows (id, title, purpose, description, scope_json, triggers_json, recipe_json, enabled, created_at, updated_at)
             VALUES ('w1', 'Keep the repo light', 'Files', NULL, '{"kind":"system"}', '[]',
                     '{"kind":"builtin","recipeId":"genie.relocate-file"}', 1, '2026-01-01', '2026-01-01')`,
        ).run();

        runMigrations(d);

        expect(
            d.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM flows').get()!.n,
        ).toBe(0);
    });
});

describe('the columns scope needs', () => {
    it('carries title, purpose, description and scope', () => {
        const d = preV74();
        runMigrations(d);

        const cols = columns(d, 'flows');
        for (const name of ['id', 'app_id', 'title', 'purpose', 'description', 'scope_json', 'graph_json', 'enabled']) {
            expect(cols.has(name), `flows has no ${name}`).toBe(true);
        }
    });

    it('lets app_id be null, because a system flow has no owning app', () => {
        const d = preV74();
        runMigrations(d);

        expect(columns(d, 'flows').get('app_id')?.notnull).toBe(0);
        expect(() =>
            d
                .prepare(
                    `INSERT INTO flows (id, app_id, title, purpose, scope_json, graph_json, enabled, created_at, updated_at)
                     VALUES ('s1', NULL, 'Machine wide', 'Files', '{"kind":"system"}', '{"nodes":[],"edges":[]}', 0, 'x', 'x')`,
                )
                .run(),
        ).not.toThrow();
    });

    it('still takes a GApp flow away with its app', () => {
        // The cascade is why `app_id` was NOT NULL in the first place, and it is
        // the half that must survive going nullable: a scheduled flow outliving
        // its app keeps firing after the user thought they had removed it.
        const d = preV74();
        runMigrations(d);
        seedApp(d, 'com.example.gone');
        d.prepare(
            `INSERT INTO flows (id, app_id, title, purpose, scope_json, graph_json, enabled, created_at, updated_at)
             VALUES ('g1', 'com.example.gone', 'Theirs', 'Files', '{"kind":"gapp","appId":"com.example.gone"}', '{}', 1, 'x', 'x')`,
        ).run();

        d.pragma('foreign_keys = ON');
        d.prepare('DELETE FROM app_grants WHERE app_id = ?').run('com.example.gone');

        expect(d.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM flows').get()!.n).toBe(0);
    });

    it('leaves a system flow alone when an unrelated app is removed', () => {
        // The positive control for the cascade: "the row is gone" also passes if
        // the cascade is too wide.
        const d = preV74();
        runMigrations(d);
        seedApp(d, 'com.example.gone');
        d.prepare(
            `INSERT INTO flows (id, app_id, title, purpose, scope_json, graph_json, enabled, created_at, updated_at)
             VALUES ('s2', NULL, 'Mine', 'Files', '{"kind":"system"}', '{}', 0, 'x', 'x')`,
        ).run();

        d.pragma('foreign_keys = ON');
        d.prepare('DELETE FROM app_grants WHERE app_id = ?').run('com.example.gone');

        expect(d.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM flows').get()!.n).toBe(1);
    });
});

describe('replaying the migration tail', () => {
    it('is safe to run twice, because the suite rewinds and walks it again', () => {
        // `ALTER TABLE ... RENAME TO` has no IF NOT EXISTS, and v47 took 36 tests
        // in four unrelated files down by forgetting it.
        const d = new Database(':memory:');
        runMigrations(d);
        d.prepare('DELETE FROM schema_version WHERE version >= 74').run();

        expect(() => runMigrations(d)).not.toThrow();
        expect(tables(d).has('flows')).toBe(true);
        expect(tables(d).has('gapp_flows')).toBe(false);
    });

    it('runs on a database that never had either table', () => {
        const fresh = new Database(':memory:');
        expect(() => runMigrations(fresh)).not.toThrow();
        expect(tables(fresh).has('flows')).toBe(true);
        // Which `flows`? The GRAPH one. Asserting the table exists would pass
        // just as well against the recipe table this migration removes.
        expect(columns(fresh, 'flows').has('graph_json')).toBe(true);
        expect(columns(fresh, 'flows').has('recipe_json')).toBe(false);
    });
});
