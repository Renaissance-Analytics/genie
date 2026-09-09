import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import { addListItem } from '../service';
import { workspaceListsView } from '../workspace-view';

/**
 * What the PANEL shows: one workspace's UserList, and every agent's AgentList
 * grouped by the agent that owns it.
 *
 * The grouping is the whole job. The lists share one table and one workspace
 * holds many agents, so a view that forgets to group renders every agent's
 * private checklist as one undifferentiated pile — which is not a list anyone
 * can act on, and quietly implies the items are the reader's.
 */

function seeded(): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db);
    for (const [id, name] of [
        ['ws-1', 'One'],
        ['ws-2', 'Two'],
    ]) {
        db.prepare(
            `INSERT INTO workspaces
                (id, tynn_project_id, tynn_project_name, project_id, project_name,
                 shape, path, sort_order)
             VALUES (?, ?, ?, ?, ?, 'simple', ?, 0)`,
        ).run(id, `p-${id}`, name, `p-${id}`, name, `/tmp/${id}`);
    }
    return db;
}

const add = (
    db: Database.Database,
    workspaceId: string,
    agentName: string,
    list: 'agent' | 'user',
    text: string,
) => {
    const r = addListItem(db, { workspaceId, agentName, list, text });
    if (!r.ok) throw new Error(r.error);
    return r.todo;
};

describe('workspaceListsView', () => {
    it('groups agent items under the agent that owns them', () => {
        const db = seeded();
        add(db, 'ws-1', 'alpha', 'agent', 'alpha one');
        add(db, 'ws-1', 'beta', 'agent', 'beta one');
        add(db, 'ws-1', 'alpha', 'agent', 'alpha two');

        const view = workspaceListsView(db, 'ws-1');

        expect(view.agents.map((a) => a.agentName)).toEqual(['alpha', 'beta']);
        expect(view.agents[0]!.items.map((i) => i.text)).toEqual(['alpha one', 'alpha two']);
        expect(view.agents[1]!.items.map((i) => i.text)).toEqual(['beta one']);
    });

    it('carries the UserList with WHO asked for each item', () => {
        const db = seeded();
        add(db, 'ws-1', 'alpha', 'user', 'Approve the login');

        const view = workspaceListsView(db, 'ws-1');

        expect(view.user).toHaveLength(1);
        expect(view.user[0]!.text).toBe('Approve the login');
        expect(view.user[0]!.agentName).toBe('alpha');
        // The id is what the panel sends back to resolve it.
        expect(view.user[0]!.id).toBeTruthy();
    });

    it('never mixes one workspace’s lists into another’s', () => {
        const db = seeded();
        add(db, 'ws-1', 'alpha', 'agent', 'here');
        add(db, 'ws-2', 'alpha', 'agent', 'elsewhere');
        add(db, 'ws-2', 'alpha', 'user', 'elsewhere too');

        const view = workspaceListsView(db, 'ws-1');

        expect(view.agents).toHaveLength(1);
        expect(view.agents[0]!.items.map((i) => i.text)).toEqual(['here']);
        expect(view.user).toEqual([]);
    });

    it('counts the OPEN items, which is what the header badge shows', () => {
        const db = seeded();
        add(db, 'ws-1', 'alpha', 'agent', 'one');
        add(db, 'ws-1', 'alpha', 'user', 'two');
        add(db, 'ws-1', 'beta', 'user', 'three');

        const view = workspaceListsView(db, 'ws-1');

        // The badge counts what is waiting on a PERSON. An agent's own
        // checklist is not the user's work and must not inflate their badge.
        expect(view.userCount).toBe(2);
    });

    it('is empty, not broken, for a workspace nobody has used', () => {
        const view = workspaceListsView(seeded(), 'ws-1');
        expect(view).toEqual({ agents: [], user: [], userCount: 0 });
    });
});
