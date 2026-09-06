import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import {
    deleteFlowIn,
    getFlowIn,
    listFlowsIn,
    listFlowsVisibleToIn,
    listScheduledFlowsIn,
    setFlowEnabledIn,
    upsertFlowIn,
} from '../store';
import type { FlowScope } from '../types';

/**
 * One table, and scope is a column on it.
 *
 * Genie used to have two flow tables because it had two flow systems. It has
 * one of each now (v74): a GApp flow is a flow whose scope is `gapp`, not a
 * different kind of thing. These tests hold down what that costs and what it
 * buys.
 *
 * The properties in rough order of how badly their absence would hurt:
 *
 *   1. **A GApp flow still dies with its app.** That is why `app_id` was NOT
 *      NULL before, and going nullable must not lose it — a scheduled flow
 *      outliving its app is what keeps firing after somebody thought they had
 *      removed it.
 *   2. **`app_id` is DERIVED from the scope**, never taken from the caller. Two
 *      fields that must agree are two fields that eventually do not.
 *   3. **A new flow is born disarmed**, whatever the caller passes by omission.
 *   4. **A corrupt row reads back, and is refused** — never guessed at, and in
 *      particular never run as `system` because its scope would not parse.
 */

let db: Database.Database;

beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
});

function seedApp(appId: string, revoked = false): void {
    db.prepare(
        `INSERT INTO app_grants
            (app_id, workspace_id, name, version, slug, scope, workspaces_json,
             capabilities_json, manifest_json, install_path, revoked, installed_at, updated_at)
         VALUES (?, 'ws-1', ?, '1.0.0', 'app', 'self', '[]', '[]', '{}', '/tmp/a', ?, 'x', 'x')`,
    ).run(appId, appId, revoked ? 1 : 0);
}

const graph = (nodes: unknown[] = []) => ({ nodes, edges: [] });

const scheduleNode = (cron: string, id = 'sched') => ({
    id,
    type: '@particle-academy/schedule_trigger',
    position: { x: 0, y: 0 },
    data: { kind: '@particle-academy/schedule_trigger', label: 'Nightly', config: { cron } },
});

function save(id: string, scope: FlowScope, extra: Record<string, unknown> = {}): void {
    upsertFlowIn(db, { id, title: id, scope, graph: graph(), ...extra });
}

describe('storing a flow at any scope', () => {
    it('round-trips a system flow, which has no owning app', () => {
        save('f1', { kind: 'system' });

        const flow = getFlowIn(db, 'f1')!;
        expect(flow.scope).toEqual({ kind: 'system' });
        expect(flow.appId).toBeNull();
        expect(flow.purpose).toBe('Automation');
    });

    it('round-trips a workspace flow', () => {
        save('f2', { kind: 'workspace', workspaceId: 'ws-7' });

        expect(getFlowIn(db, 'f2')!.scope).toEqual({ kind: 'workspace', workspaceId: 'ws-7' });
        expect(getFlowIn(db, 'f2')!.appId).toBeNull();
    });

    it('derives app_id from a gapp scope rather than trusting a caller', () => {
        seedApp('com.example.trader');
        save('f3', { kind: 'gapp', appId: 'com.example.trader' });

        expect(getFlowIn(db, 'f3')!.appId).toBe('com.example.trader');
    });

    it('is born disarmed unless the caller says otherwise', () => {
        // Arming is a separate decision from creating. Creation must not be a
        // second door onto standing permission to act unattended.
        save('f4', { kind: 'system' });
        expect(getFlowIn(db, 'f4')!.enabled).toBe(false);

        save('f5', { kind: 'system' }, { enabled: true });
        expect(getFlowIn(db, 'f5')!.enabled).toBe(true);
    });

    it('updates in place rather than growing a second row', () => {
        save('f6', { kind: 'system' }, { title: 'First' });
        save('f6', { kind: 'system' }, { title: 'Second' });

        expect(listFlowsIn(db)).toHaveLength(1);
        expect(getFlowIn(db, 'f6')!.title).toBe('Second');
    });

    it('disables without deleting, because that is what a pause is', () => {
        save('f7', { kind: 'system' }, { enabled: true });
        setFlowEnabledIn(db, 'f7', false);

        expect(getFlowIn(db, 'f7')!.enabled).toBe(false);
        expect(getFlowIn(db, 'f7')).not.toBeNull();
    });

    it('deletes', () => {
        save('f8', { kind: 'system' });
        deleteFlowIn(db, 'f8');
        expect(getFlowIn(db, 'f8')).toBeNull();
    });

    it('lists grouped by purpose then title, which is how the menu reads', () => {
        save('b', { kind: 'system' }, { title: 'Beta', purpose: 'Files' });
        save('a', { kind: 'system' }, { title: 'Alpha', purpose: 'Files' });
        save('c', { kind: 'system' }, { title: 'Gamma', purpose: 'Agents' });

        expect(listFlowsIn(db).map((f) => f.title)).toEqual(['Gamma', 'Alpha', 'Beta']);
    });
});

describe('a GApp flow cannot outlive its app', () => {
    it('goes when the app is uninstalled', () => {
        seedApp('com.example.gone');
        save('g1', { kind: 'gapp', appId: 'com.example.gone' }, { enabled: true });

        db.pragma('foreign_keys = ON');
        db.prepare('DELETE FROM app_grants WHERE app_id = ?').run('com.example.gone');

        expect(getFlowIn(db, 'g1')).toBeNull();
    });

    it('takes nothing else with it', () => {
        // The positive control. "The row is gone" also passes if the cascade is
        // too wide, and a cascade that reaped the user's own flows would be far
        // worse than one that reaped nothing.
        seedApp('com.example.gone');
        save('g2', { kind: 'gapp', appId: 'com.example.gone' });
        save('s1', { kind: 'system' });
        save('w1', { kind: 'workspace', workspaceId: 'ws-1' });

        db.pragma('foreign_keys = ON');
        db.prepare('DELETE FROM app_grants WHERE app_id = ?').run('com.example.gone');

        expect(listFlowsIn(db).map((f) => f.id).sort()).toEqual(['s1', 'w1']);
    });
});

describe('who can see which flows', () => {
    beforeEach(() => {
        seedApp('app-a');
        seedApp('app-b');
        save('sys', { kind: 'system' });
        save('ws7', { kind: 'workspace', workspaceId: 'ws-7' });
        save('ws9', { kind: 'workspace', workspaceId: 'ws-9' });
        save('ga', { kind: 'gapp', appId: 'app-a' });
        save('gb', { kind: 'gapp', appId: 'app-b' });
    });

    it('shows a GApp only its own — no system flows, no other apps', () => {
        expect(listFlowsVisibleToIn(db, { kind: 'gapp', appId: 'app-a' }).map((f) => f.id)).toEqual([
            'ga',
        ]);
    });

    it('shows a workspace its own plus the machine-wide ones', () => {
        expect(
            listFlowsVisibleToIn(db, { kind: 'workspace', workspaceId: 'ws-7' })
                .map((f) => f.id)
                .sort(),
        ).toEqual(['sys', 'ws7']);
    });

    it('shows the machine everything', () => {
        expect(listFlowsVisibleToIn(db, { kind: 'system' })).toHaveLength(5);
    });
});

describe('malformed stored rows, which happen', () => {
    it('reads a corrupt graph back as null rather than throwing', () => {
        save('bad', { kind: 'system' });
        db.prepare('UPDATE flows SET graph_json = ? WHERE id = ?').run('{not json', 'bad');

        expect(getFlowIn(db, 'bad')!.graph).toBeNull();
        expect(() => listFlowsIn(db)).not.toThrow();
    });

    it('reads an unreadable scope back as null, never as system', () => {
        // The dangerous default. A row whose scope will not parse must not
        // quietly become the WIDEST scope — that would turn a corrupt field into
        // a flow the whole machine can see and every event reaches.
        save('bad2', { kind: 'workspace', workspaceId: 'ws-7' });
        db.prepare('UPDATE flows SET scope_json = ? WHERE id = ?').run('{"kind":"whatever"}', 'bad2');

        expect(getFlowIn(db, 'bad2')!.scope).toBeNull();
    });

    it('hides an unreadable-scope flow from every vantage but the machine', () => {
        save('bad3', { kind: 'system' });
        db.prepare('UPDATE flows SET scope_json = ? WHERE id = ?').run('nonsense', 'bad3');

        expect(listFlowsVisibleToIn(db, { kind: 'workspace', workspaceId: 'ws-1' })).toHaveLength(0);
        expect(listFlowsVisibleToIn(db, { kind: 'gapp', appId: 'app-a' })).toHaveLength(0);
        // Still findable where it can be repaired.
        expect(listFlowsVisibleToIn(db, { kind: 'system' }).map((f) => f.id)).toContain('bad3');
    });
});

describe('finding what needs arming', () => {
    it('lists a flow whose graph declares a valid schedule', () => {
        upsertFlowIn(db, {
            id: 'nightly',
            title: 'Nightly',
            scope: { kind: 'system' },
            graph: graph([scheduleNode('0 3 * * *')]),
            enabled: true,
        });

        expect(listScheduledFlowsIn(db)).toEqual([
            { flowId: 'nightly', appId: null, title: 'Nightly', nodeId: 'sched', cron: '0 3 * * *' },
        ]);
    });

    it('ignores a flow that is disabled', () => {
        upsertFlowIn(db, {
            id: 'off',
            title: 'Off',
            scope: { kind: 'system' },
            graph: graph([scheduleNode('0 3 * * *')]),
            enabled: false,
        });

        expect(listScheduledFlowsIn(db)).toEqual([]);
    });

    it('ignores a flow whose app was revoked', () => {
        // Revocation is total. Leaving the timer armed would mean firing every
        // night purely to be refused.
        seedApp('app-revoked', true);
        upsertFlowIn(db, {
            id: 'theirs',
            title: 'Theirs',
            scope: { kind: 'gapp', appId: 'app-revoked' },
            graph: graph([scheduleNode('0 3 * * *')]),
            enabled: true,
        });

        expect(listScheduledFlowsIn(db)).toEqual([]);
    });

    it('ignores a corrupt graph rather than arming a guess', () => {
        upsertFlowIn(db, {
            id: 'broken',
            title: 'Broken',
            scope: { kind: 'system' },
            graph: graph([scheduleNode('0 3 * * *')]),
            enabled: true,
        });
        db.prepare('UPDATE flows SET graph_json = ? WHERE id = ?').run('{oops', 'broken');

        expect(listScheduledFlowsIn(db)).toEqual([]);
    });

    it('ignores an unreadable scope, because it cannot say whose authority runs', () => {
        upsertFlowIn(db, {
            id: 'scopeless',
            title: 'Scopeless',
            scope: { kind: 'system' },
            graph: graph([scheduleNode('0 3 * * *')]),
            enabled: true,
        });
        db.prepare('UPDATE flows SET scope_json = ? WHERE id = ?').run('{}', 'scopeless');

        expect(listScheduledFlowsIn(db)).toEqual([]);
    });

    it('ignores a manual-only flow', () => {
        upsertFlowIn(db, {
            id: 'manual',
            title: 'Manual',
            scope: { kind: 'system' },
            graph: graph([
                {
                    id: 'start',
                    type: '@particle-academy/manual_trigger',
                    position: { x: 0, y: 0 },
                    data: { kind: '@particle-academy/manual_trigger', label: 'Start', config: {} },
                },
            ]),
            enabled: true,
        });

        expect(listScheduledFlowsIn(db)).toEqual([]);
    });
});
