import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceTodo, listWorkspaceTodos, runMigrations } from '../../db';
import { readUserList, resolveUserListItem, type ListNudgeIO } from '../service';

/**
 * The loop that makes the UserList worth building: the human ticks an item off,
 * and the agent that asked for it FINDS OUT.
 *
 * A UserList exists so an agent can keep going while a person does something —
 * unlike ForceTheQuestion, which parks the agent on an answer. That only pays
 * off if the completion actually gets back. A tick in the UI over a nudge that
 * went nowhere is worse than no feature: the human believes they have unblocked
 * someone who is still waiting.
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

/** A nudge IO that records every delivery instead of touching the broker. */
function recordingIO(live: Record<string, string | null> = { alpha: 't-alpha', beta: 't-beta' }) {
    const delivered: { terminalId: string; text: string }[] = [];
    const io: ListNudgeIO = {
        liveTerminalFor: (_ws, agentName) => live[agentName] ?? null,
        deliver: (terminalId, text) => {
            delivered.push({ terminalId, text });
            return { ok: true };
        },
    };
    return { io, delivered };
}

describe('marking a user item done reaches the agent that asked for it', () => {
    it('delivers to the AUTHORING agent’s live terminal, naming the item', () => {
        const db = seeded();
        const { io, delivered } = recordingIO();
        const made = createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'alpha',
            text: 'Approve the staging login',
        });
        if (!made.ok) throw new Error(made.error);

        const r = resolveUserListItem(db, io, {
            todoId: made.todo.id,
            action: 'done',
            comment: 'Approved, you are unblocked.',
        });

        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error(r.error);
        expect(r.nudge.delivered).toBe(true);
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.terminalId).toBe('t-alpha');
        // The agent has to be able to tell WHICH item without going to look.
        expect(delivered[0]?.text).toContain('Approve the staging login');
        expect(delivered[0]?.text).toContain('Approved, you are unblocked.');
        expect(delivered[0]?.text).toMatch(/done/i);
    });

    it('nudges the author, NOT the workspace’s other agents', () => {
        const db = seeded();
        const { io, delivered } = recordingIO();
        createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'alpha',
            text: 'alpha needs this',
        });
        const betas = createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'beta',
            text: 'beta needs this',
        });
        if (!betas.ok) throw new Error(betas.error);

        resolveUserListItem(db, io, {
            todoId: betas.todo.id,
            action: 'done',
            comment: 'ok',
        });

        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.terminalId).toBe('t-beta');
        expect(delivered[0]?.text).toContain('beta needs this');
        expect(delivered[0]?.text).not.toContain('alpha needs this');
    });

    it('carries a thrown-back or refused outcome too, not only done', () => {
        const db = seeded();
        const { io, delivered } = recordingIO();
        const made = createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'alpha',
            text: 'Rotate the token',
        });
        if (!made.ok) throw new Error(made.error);

        resolveUserListItem(db, io, {
            todoId: made.todo.id,
            action: 'refused',
            comment: 'Use the staging account instead.',
        });

        // A refusal is exactly the outcome an agent must not miss — it is still
        // blocked, and on a premise that just turned out to be wrong.
        expect(delivered[0]?.text).toMatch(/refus/i);
        expect(delivered[0]?.text).toContain('Use the staging account instead.');
    });
});

describe('a nudge that cannot land says so — it is never reported as delivered', () => {
    it('reports the agent is not running rather than claiming a delivery', () => {
        const db = seeded();
        const { io, delivered } = recordingIO({ alpha: null });
        const made = createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'alpha',
            text: 'Approve access',
        });
        if (!made.ok) throw new Error(made.error);

        const r = resolveUserListItem(db, io, {
            todoId: made.todo.id,
            action: 'done',
            comment: 'done',
        });

        // The RESOLUTION still stands — the human did the thing, and that fact
        // must not be lost because nobody was listening.
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error(r.error);
        expect(r.nudge.delivered).toBe(false);
        if (r.nudge.delivered) throw new Error('expected no delivery');
        expect(r.nudge.reason).toMatch(/not running|no longer/i);
        expect(delivered).toHaveLength(0);
        expect(listWorkspaceTodos(db, 'ws-1', 'user')).toEqual([]);
    });

    it('passes the broker’s own refusal through instead of inventing a cause', () => {
        const db = seeded();
        const io: ListNudgeIO = {
            liveTerminalFor: () => 't-alpha',
            deliver: () => ({ ok: false, reason: 'that terminal has no agent identity' }),
        };
        const made = createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'alpha',
            text: 'x',
        });
        if (!made.ok) throw new Error(made.error);

        const r = resolveUserListItem(db, io, { todoId: made.todo.id, action: 'done', comment: 'y' });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error(r.error);
        expect(r.nudge.delivered).toBe(false);
        if (r.nudge.delivered) throw new Error('expected no delivery');
        expect(r.nudge.reason).toContain('no agent identity');
    });
});

describe('nothing else nudges', () => {
    it('READING the user list nudges nobody', () => {
        const db = seeded();
        const io: ListNudgeIO = {
            liveTerminalFor: () => 't-alpha',
            deliver: vi.fn(() => ({ ok: true as const })),
        };
        createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'alpha',
            text: 'untouched',
        });

        expect(readUserList(db, 'ws-1').map((i) => i.text)).toEqual(['untouched']);
        expect(io.deliver).not.toHaveBeenCalled();
    });

    it('an item the user has NOT touched stays open and nudges nobody', () => {
        const db = seeded();
        const { io, delivered } = recordingIO();
        const touched = createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'alpha',
            text: 'touched',
        });
        createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'beta',
            text: 'untouched',
        });
        if (!touched.ok) throw new Error(touched.error);

        resolveUserListItem(db, io, { todoId: touched.todo.id, action: 'done', comment: 'ok' });

        // Positive control: the touched one DID nudge, so "exactly one" is a
        // real one-and-only-one and not a delivery path that is simply dead.
        expect(delivered.map((d) => d.terminalId)).toEqual(['t-alpha']);
        expect(readUserList(db, 'ws-1').map((i) => i.text)).toEqual(['untouched']);
    });

    it('refuses to resolve the same item twice, and does not nudge again', () => {
        const db = seeded();
        const { io, delivered } = recordingIO();
        const made = createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'alpha',
            text: 'once',
        });
        if (!made.ok) throw new Error(made.error);

        expect(resolveUserListItem(db, io, { todoId: made.todo.id, action: 'done', comment: 'a' }).ok).toBe(true);
        expect(resolveUserListItem(db, io, { todoId: made.todo.id, action: 'done', comment: 'b' }).ok).toBe(false);
        expect(delivered).toHaveLength(1);
    });

    it('requires the human’s comment, and nudges nobody when it is missing', () => {
        const db = seeded();
        const { io, delivered } = recordingIO();
        const made = createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'alpha',
            text: 'x',
        });
        if (!made.ok) throw new Error(made.error);

        expect(resolveUserListItem(db, io, { todoId: made.todo.id, action: 'done', comment: '  ' }).ok).toBe(false);
        expect(delivered).toHaveLength(0);
        // Still open — a rejected resolution must not consume the item.
        expect(readUserList(db, 'ws-1')).toHaveLength(1);
    });

    it('does not nudge an agent in a DIFFERENT workspace that shares the name', () => {
        const db = seeded();
        const seen: string[] = [];
        const io: ListNudgeIO = {
            liveTerminalFor: (ws, name) => {
                seen.push(`${ws}/${name}`);
                return 't-x';
            },
            deliver: () => ({ ok: true }),
        };
        const made = createWorkspaceTodo(db, {
            workspaceId: 'ws-2',
            kind: 'user',
            agentName: 'alpha',
            text: 'in ws-2',
        });
        if (!made.ok) throw new Error(made.error);

        resolveUserListItem(db, io, { todoId: made.todo.id, action: 'done', comment: 'ok' });
        expect(seen).toEqual(['ws-2/alpha']);
    });
});
