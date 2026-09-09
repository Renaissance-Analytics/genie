import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import { handleListsRequest, type ListsHostIO } from '../host';

/**
 * The seam between a TERMINAL and a list: everything the `lists` tool does
 * after the protocol layer has checked the arguments.
 *
 * This is where the feature's identity rule is actually applied, so it is where
 * the two failures that matter live: an agent reaching another agent's list,
 * and a caller whose terminal cannot be resolved being handed an EMPTY list
 * instead of a reason. The second is the nastier one — an empty list and a
 * broken list look identical to whoever reads them.
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

/** Terminals: `t-alpha`/`t-beta` in ws-1, `t-far` in ws-2, plus two broken ones. */
function io(db: Database.Database): ListsHostIO {
    const specs: Record<string, { workspace_id: string | null; meta?: { whisper_purpose?: unknown } | null }> = {
        't-alpha': { workspace_id: 'ws-1', meta: { whisper_purpose: 'alpha' } },
        't-beta': { workspace_id: 'ws-1', meta: { whisper_purpose: 'beta' } },
        't-far': { workspace_id: 'ws-2', meta: { whisper_purpose: 'alpha' } },
        't-nows': { workspace_id: null, meta: { whisper_purpose: 'alpha' } },
        't-noname': { workspace_id: 'ws-1', meta: {} },
    };
    return { db, specOf: (id) => specs[id] ?? null };
}

const okResult = (r: ReturnType<typeof handleListsRequest>) => {
    if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
    return r;
};

describe('handleListsRequest resolves the caller before it touches a list', () => {
    it('shows the caller’s OWN agent list and the shared user list', () => {
        const db = seeded();
        const d = io(db);
        handleListsRequest(d, 't-alpha', { action: 'add', list: 'agent', text: 'alpha item' });
        handleListsRequest(d, 't-beta', { action: 'add', list: 'agent', text: 'beta item' });
        handleListsRequest(d, 't-beta', { action: 'add', list: 'user', text: 'human item' });

        const r = okResult(handleListsRequest(d, 't-alpha', { action: 'show' }));

        expect(r.agentName).toBe('alpha');
        expect(r.agent.map((i) => i.text)).toEqual(['alpha item']);
        // The USER list is shared, so alpha sees what beta asked the human for…
        expect(r.user.map((i) => i.text)).toEqual(['human item']);
        // …and can see WHO is waiting on it.
        expect(r.user[0]?.agentName).toBe('beta');
    });

    it('scopes to the WORKSPACE as well as the agent', () => {
        const db = seeded();
        const d = io(db);
        handleListsRequest(d, 't-alpha', { action: 'add', text: 'in ws-1' });

        // Same agent NAME, different workspace: a different list.
        expect(okResult(handleListsRequest(d, 't-far', { action: 'show' })).agent).toEqual([]);
    });

    it('REFUSES a terminal with no workspace, naming the missing fact', () => {
        const r = handleListsRequest(io(seeded()), 't-nows', { action: 'show' });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected a refusal');
        expect(r.error).toMatch(/workspace/i);
    });

    it('REFUSES a terminal with no agent name rather than showing an empty list', () => {
        const r = handleListsRequest(io(seeded()), 't-noname', { action: 'show' });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected a refusal');
        expect(r.error).toMatch(/name/i);
    });

    it('REFUSES an unknown terminal', () => {
        const r = handleListsRequest(io(seeded()), 't-ghost', { action: 'show' });
        expect(r.ok).toBe(false);
    });
});

describe('the actions do what they say and report it', () => {
    it('`add` returns the list WITH the new item, so one call is enough', () => {
        const d = io(seeded());
        const r = okResult(handleListsRequest(d, 't-alpha', { action: 'add', text: 'Read the RFC' }));
        expect(r.agent.map((i) => i.text)).toEqual(['Read the RFC']);
        expect(r.note).toMatch(/added/i);
    });

    it('`add` to the user list attributes the item to the CALLING agent', () => {
        const d = io(seeded());
        const r = okResult(
            handleListsRequest(d, 't-alpha', { action: 'add', list: 'user', text: 'Approve it' }),
        );
        expect(r.user[0]?.agentName).toBe('alpha');
    });

    it('surfaces the cap refusal as an error, not as a silently unchanged list', () => {
        const d = io(seeded());
        for (let i = 0; i < 10; i++) {
            handleListsRequest(d, 't-alpha', { action: 'add', text: `item ${i}` });
        }
        const r = handleListsRequest(d, 't-alpha', { action: 'add', text: 'one too many' });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected a refusal');
        expect(r.error).toMatch(/10|most it takes/i);
    });

    it('`done` completes the caller’s own item', () => {
        const d = io(seeded());
        const added = okResult(handleListsRequest(d, 't-alpha', { action: 'add', text: 'Read the RFC' }));
        const id = added.agent[0]!.id;

        const r = okResult(handleListsRequest(d, 't-alpha', { action: 'done', id }));

        expect(r.agent).toEqual([]);
        expect(r.note).toMatch(/done/i);
    });

    it('`done` REFUSES another agent’s item', () => {
        const d = io(seeded());
        const added = okResult(handleListsRequest(d, 't-alpha', { action: 'add', text: 'alpha’s' }));
        const id = added.agent[0]!.id;

        const r = handleListsRequest(d, 't-beta', { action: 'done', id });

        expect(r.ok).toBe(false);
        // …and it is still on alpha's list.
        expect(okResult(handleListsRequest(d, 't-alpha', { action: 'show' })).agent).toHaveLength(1);
    });

    it('`clear` empties the caller’s list and says how many it took', () => {
        const d = io(seeded());
        handleListsRequest(d, 't-alpha', { action: 'add', text: 'one' });
        handleListsRequest(d, 't-alpha', { action: 'add', text: 'two' });

        const r = okResult(handleListsRequest(d, 't-alpha', { action: 'clear' }));

        expect(r.agent).toEqual([]);
        expect(r.note).toMatch(/2/);
    });

    it('`clear` on an empty list says so rather than claiming it cleared something', () => {
        const d = io(seeded());
        const r = okResult(handleListsRequest(d, 't-alpha', { action: 'clear' }));
        expect(r.note).toMatch(/nothing|already empty|0/i);
    });
});
