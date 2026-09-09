import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import {
    addListItem,
    clearAgentList,
    completeAgentItem,
    readAgentList,
    readUserList,
} from '../service';

/**
 * The AgentList's own lifecycle: an agent adds to it, ticks things off it, and
 * clears it — and none of that reaches across to another agent's list or to the
 * user's.
 *
 * The owner's spec is "one list per agent, max 10 items, persists until
 * cleared". Two of those three words are only true if `done` and `clear` exist
 * and are SCOPED: without an owner check they are one agent silently editing
 * another's list, which reads exactly like a list that lost its own items.
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

/** Add one agent item and hand back its row, failing loudly if the add was refused. */
function added(
    db: Database.Database,
    input: { workspaceId: string; agentName: string; list?: 'agent' | 'user'; text: string },
) {
    const r = addListItem(db, { list: 'agent', ...input });
    if (!r.ok) throw new Error(r.error);
    return r.todo;
}

describe('completeAgentItem — an agent ticks something off its OWN list', () => {
    it('removes the item from the list it was on', () => {
        const db = seeded();
        const item = added(db, { workspaceId: 'ws-1', agentName: 'alpha', text: 'Read the RFC' });
        added(db, { workspaceId: 'ws-1', agentName: 'alpha', text: 'Write the test' });

        const r = completeAgentItem(db, { todoId: item.id, agentName: 'alpha' });

        expect(r.ok).toBe(true);
        expect(readAgentList(db, 'ws-1', 'alpha').map((t) => t.text)).toEqual(['Write the test']);
    });

    it('frees a slot against the cap, so a full list can be worked down', () => {
        const db = seeded();
        const first = added(db, { workspaceId: 'ws-1', agentName: 'alpha', text: 'item 0' });
        for (let i = 1; i < 10; i++) {
            added(db, { workspaceId: 'ws-1', agentName: 'alpha', text: `item ${i}` });
        }
        // Full: the 11th is refused.
        expect(addListItem(db, { workspaceId: 'ws-1', agentName: 'alpha', list: 'agent', text: 'one too many' }).ok).toBe(false);

        completeAgentItem(db, { todoId: first.id, agentName: 'alpha' });

        expect(addListItem(db, { workspaceId: 'ws-1', agentName: 'alpha', list: 'agent', text: 'now it fits' }).ok).toBe(true);
    });

    it('REFUSES to tick off another agent’s item, and names the problem', () => {
        // The positive control for the scoping: without an owner check this
        // succeeds, and beta's list silently loses an item it never touched.
        const db = seeded();
        const alphas = added(db, { workspaceId: 'ws-1', agentName: 'alpha', text: 'alpha’s own' });

        const r = completeAgentItem(db, { todoId: alphas.id, agentName: 'beta' });

        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected a refusal');
        expect(r.error).toMatch(/not.*your|another agent|belongs/i);
        // …and alpha still has it.
        expect(readAgentList(db, 'ws-1', 'alpha')).toHaveLength(1);
    });

    it('refuses a USER item — those are the person’s to resolve, and resolving one nudges an agent', () => {
        const db = seeded();
        const userItem = addListItem(db, {
            workspaceId: 'ws-1',
            agentName: 'alpha',
            list: 'user',
            text: 'Approve the staging login',
        });
        if (!userItem.ok) throw new Error(userItem.error);

        const r = completeAgentItem(db, { todoId: userItem.todo.id, agentName: 'alpha' });

        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected a refusal');
        expect(readUserList(db, 'ws-1')).toHaveLength(1);
    });

    it('refuses an id that is not there rather than reporting a silent success', () => {
        const db = seeded();
        const r = completeAgentItem(db, { todoId: 'no-such-id', agentName: 'alpha' });
        expect(r.ok).toBe(false);
    });
});

describe('clearAgentList — "persists until cleared" is the other half of the promise', () => {
    it('empties the calling agent’s list and says how many it took', () => {
        const db = seeded();
        added(db, { workspaceId: 'ws-1', agentName: 'alpha', text: 'one' });
        added(db, { workspaceId: 'ws-1', agentName: 'alpha', text: 'two' });

        const r = clearAgentList(db, 'ws-1', 'alpha');

        expect(r.cleared).toBe(2);
        expect(readAgentList(db, 'ws-1', 'alpha')).toEqual([]);
    });

    it('leaves every OTHER agent’s list alone', () => {
        const db = seeded();
        added(db, { workspaceId: 'ws-1', agentName: 'alpha', text: 'alpha one' });
        added(db, { workspaceId: 'ws-1', agentName: 'beta', text: 'beta one' });
        added(db, { workspaceId: 'ws-2', agentName: 'alpha', text: 'other workspace' });

        clearAgentList(db, 'ws-1', 'alpha');

        expect(readAgentList(db, 'ws-1', 'beta').map((t) => t.text)).toEqual(['beta one']);
        expect(readAgentList(db, 'ws-2', 'alpha').map((t) => t.text)).toEqual(['other workspace']);
    });

    it('leaves the USER list alone — an agent cannot clear the person’s work', () => {
        const db = seeded();
        const u = addListItem(db, {
            workspaceId: 'ws-1',
            agentName: 'alpha',
            list: 'user',
            text: 'Approve the staging login',
        });
        if (!u.ok) throw new Error(u.error);
        added(db, { workspaceId: 'ws-1', agentName: 'alpha', text: 'agent item' });

        clearAgentList(db, 'ws-1', 'alpha');

        expect(readUserList(db, 'ws-1').map((t) => t.text)).toEqual(['Approve the staging login']);
    });

    it('clearing an empty list is 0, not an error', () => {
        const db = seeded();
        expect(clearAgentList(db, 'ws-1', 'alpha').cleared).toBe(0);
    });
});
