import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db';
import {
    deleteFlowIn,
    getFlowIn,
    listFlowsForAppIn,
    listScheduledFlowsIn,
    upsertFlowIn,
} from '../store';

/**
 * Where flows live, and the two properties the schema itself has to enforce.
 *
 * A flow is stored graph JSON that Genie will later EXECUTE, which makes the row
 * an authority-adjacent object even though it grants nothing on its own. Two
 * things therefore belong in the schema rather than in the callers:
 *
 *   1. Every flow belongs to an app. There is no ownerless flow, because a flow
 *      with no owner has no grant to be bounded by, and the run path would have
 *      nothing to ask `decideAppCall` about.
 *   2. Uninstalling an app takes its flows with it. A scheduled flow outliving
 *      the app that owns it is precisely the thing that keeps firing after the
 *      user thought they had removed it.
 *
 * Exercised against a real in-memory better-sqlite3 — the binary is not mocked.
 */

function db() {
    const d = new Database(':memory:');
    // Production turns this on in `getDb()`, and the two guarantees below are
    // foreign-key guarantees — without the pragma the fixture would be a laxer
    // database than the real one and would prove nothing about it.
    d.pragma('foreign_keys = ON');
    runMigrations(d);
    d.prepare(
        `INSERT INTO app_grants (app_id, workspace_id, name, version, slug, scope, manifest_json,
                                 install_path, installed_at, updated_at)
         VALUES ('app-1','ws-1','Trader','1.0.0','trader','self','{}','/tmp/app', '', '')`,
    ).run();
    return d;
}

const graph = { nodes: [{ id: 't', type: 'trigger', data: { kind: 'x' } }], edges: [] };

describe('storing a flow', () => {
    it('round-trips the graph it was given', () => {
        const d = db();
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'Nightly', graph });

        const back = getFlowIn(d, 'f1');
        expect(back).toMatchObject({ id: 'f1', appId: 'app-1', name: 'Nightly' });
        expect(back!.graph).toEqual(graph);
    });

    it('updates in place rather than growing a second row', () => {
        const d = db();
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'Nightly', graph });
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'Renamed', graph });

        expect(listFlowsForAppIn(d, 'app-1')).toHaveLength(1);
        expect(getFlowIn(d, 'f1')!.name).toBe('Renamed');
    });

    it('lists only the asking app’s flows', () => {
        const d = db();
        d.prepare(
            `INSERT INTO app_grants (app_id, workspace_id, name, version, slug, scope, manifest_json,
                                     install_path, installed_at, updated_at)
             VALUES ('app-2','ws-2','Other','1.0.0','other','self','{}','/tmp/b','','')`,
        ).run();
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'Mine', graph });
        upsertFlowIn(d, { id: 'f2', appId: 'app-2', name: 'Theirs', graph });

        expect(listFlowsForAppIn(d, 'app-1').map((f) => f.id)).toEqual(['f1']);
    });

    it('returns null for a flow that is not there', () => {
        expect(getFlowIn(db(), 'nope')).toBeNull();
    });

    it('deletes a flow', () => {
        const d = db();
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'Nightly', graph });
        deleteFlowIn(d, 'f1');

        expect(getFlowIn(d, 'f1')).toBeNull();
    });
});

describe('a flow cannot outlive its owner', () => {
    it('refuses a flow whose app does not exist', () => {
        // Enforced by the schema, not by the caller remembering. A flow with no
        // grant behind it has nothing to bound what it may do.
        expect(() =>
            upsertFlowIn(db(), { id: 'f1', appId: 'ghost', name: 'Orphan', graph }),
        ).toThrow();
    });

    it('is deleted when its app is uninstalled', () => {
        // The failure this prevents: a scheduled flow still firing after the user
        // removed the app that owned it.
        const d = db();
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'Nightly', graph });
        d.prepare(`DELETE FROM app_grants WHERE app_id = 'app-1'`).run();

        expect(getFlowIn(d, 'f1')).toBeNull();
    });
});

describe('malformed stored graphs, which happen', () => {
    it('reads a corrupt graph back as null rather than throwing', () => {
        // A row hand-edited or half-written must not take down whatever is
        // listing flows. Admission refuses an unreadable graph anyway.
        const d = db();
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'Nightly', graph });
        d.prepare(`UPDATE gapp_flows SET graph_json = '{not json' WHERE id = 'f1'`).run();

        expect(() => getFlowIn(d, 'f1')).not.toThrow();
        expect(getFlowIn(d, 'f1')!.graph).toBeNull();
    });
});

describe('finding what needs arming', () => {
    const scheduled = {
        nodes: [
            {
                id: 's',
                type: 'trigger',
                data: {
                    kind: '@particle-academy/schedule_trigger',
                    config: { cron: '0 3 * * *' },
                },
            },
        ],
        edges: [],
    };

    it('lists a flow whose graph declares a valid schedule', () => {
        const d = db();
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'Nightly', graph: scheduled });

        const armable = listScheduledFlowsIn(d);
        expect(armable).toHaveLength(1);
        expect(armable[0]).toMatchObject({ flowId: 'f1', appId: 'app-1', cron: '0 3 * * *' });
    });

    it('ignores a flow with only a manual trigger', () => {
        const d = db();
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'By hand', graph });

        expect(listScheduledFlowsIn(d)).toEqual([]);
    });

    it('ignores a flow that is disabled', () => {
        // Disabling is how a user stops a schedule without deleting the flow, so
        // it has to be honoured here — where the arming decision is made.
        const d = db();
        upsertFlowIn(d, {
            id: 'f1',
            appId: 'app-1',
            name: 'Nightly',
            graph: scheduled,
            enabled: false,
        });

        expect(listScheduledFlowsIn(d)).toEqual([]);
    });

    it('ignores a flow belonging to a REVOKED app', () => {
        // Revocation is total and immediate. Leaving a revoked app's schedule
        // armed would mean the timer keeps firing and only the bridge says no —
        // a refusal logged every night forever.
        const d = db();
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'Nightly', graph: scheduled });
        d.prepare(`UPDATE app_grants SET revoked = 1 WHERE app_id = 'app-1'`).run();

        expect(listScheduledFlowsIn(d)).toEqual([]);
    });

    it('ignores a corrupt graph rather than arming a guess', () => {
        const d = db();
        upsertFlowIn(d, { id: 'f1', appId: 'app-1', name: 'Nightly', graph: scheduled });
        d.prepare(`UPDATE gapp_flows SET graph_json = 'nonsense' WHERE id = 'f1'`).run();

        expect(listScheduledFlowsIn(d)).toEqual([]);
    });
});
