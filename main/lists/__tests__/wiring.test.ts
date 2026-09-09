import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The real db + broker wiring behind BOTH list surfaces — the local IPC handlers
 * and the host's `/api/desktop/lists/*` routes (genie#586).
 *
 * The pure halves have their own suites: `resolveUserListItem` decides whether
 * the resolution stands and what the nudge says, `buildListNudgeIO` decides who
 * hears it. What only exists HERE is the assembly, and two properties of it that
 * nothing else can see:
 *
 *  1. The nudge is attempted against the REAL broker — `isLive` and `deliver`
 *     must consult the SAME one, because "live" means deliverable and a gate
 *     that consults anything else can disagree with the delivery it guards
 *     (genie#502).
 *  2. A resolve ANNOUNCES. Every panel — local, docked or driving this host from
 *     another machine — refreshes on `lists:changed` and nothing polls, so a
 *     resolve that writes silently leaves the item it just ticked off on screen
 *     for everyone including the person who ticked it.
 */

const broker = vi.hoisted(() => ({
    agentIdForTerminal: vi.fn(),
    deliverHumanMessageToTerminalResult: vi.fn(),
}));
vi.mock('../../agentinbox/broker', () => ({ agentInboxBroker: broker }));

const dbMod = vi.hoisted(() => ({
    getDb: vi.fn(),
    listTerminalSpecs: vi.fn(),
}));
vi.mock('../../db', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../db')>()),
    ...dbMod,
}));

import { createWorkspaceTodo, runMigrations } from '../../db';
import { onListsChanged } from '../changed';
import { readWorkspaceLists, resolveUserListItemOnHost, workspaceOfListItem } from '../wiring';

function seeded(): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
        `INSERT INTO workspaces
            (id, tynn_project_id, tynn_project_name, project_id, project_name,
             shape, path, sort_order)
         VALUES (?, ?, ?, ?, ?, 'simple', ?, 0)`,
    ).run('ws-1', 'p1', 'One', 'p1', 'One', '/tmp/ws-1');
    return db;
}

/** A workspace with one open UserList item, authored by `alpha`. */
function withUserItem(): { db: Database.Database; todoId: string } {
    const db = seeded();
    dbMod.getDb.mockReturnValue(db);
    const made = createWorkspaceTodo(db, {
        workspaceId: 'ws-1',
        kind: 'user',
        agentName: 'alpha',
        text: 'Approve the staging login',
    });
    if (!made.ok) throw new Error(made.error);
    return { db, todoId: made.todo.id };
}

/** `alpha` is running on terminal `t-alpha`, and the broker can reach it. */
function alphaIsLive(): void {
    dbMod.listTerminalSpecs.mockReturnValue([
        { id: 't-alpha', workspace_id: 'ws-1', meta: { whisper_purpose: 'alpha' } },
    ]);
    broker.agentIdForTerminal.mockImplementation((id: string) =>
        id === 't-alpha' ? 'agent:alpha' : null,
    );
    broker.deliverHumanMessageToTerminalResult.mockReturnValue({ ok: true });
}

afterEach(() => vi.clearAllMocks());

describe('readWorkspaceLists', () => {
    it('projects the workspace cut a panel reads, from the real db', () => {
        withUserItem();
        const view = readWorkspaceLists('ws-1');

        expect(view.user.map((i) => i.text)).toEqual(['Approve the staging login']);
        expect(view.userCount).toBe(1);
    });
});

describe('workspaceOfListItem — the host route’s allow-list lookup', () => {
    it('names the workspace an item really belongs to', () => {
        const { todoId } = withUserItem();
        expect(workspaceOfListItem(todoId)).toBe('ws-1');
    });

    it('answers null for an id that names no item — "no such row", not "denied"', () => {
        withUserItem();
        expect(workspaceOfListItem('not-an-id')).toBeNull();
    });
});

describe('resolveUserListItemOnHost', () => {
    it('nudges the authoring agent through the broker, and says it landed', () => {
        const { todoId } = withUserItem();
        alphaIsLive();

        const r = resolveUserListItemOnHost({ todoId, action: 'done', comment: 'signed off' });

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.nudge).toEqual({ delivered: true, terminalId: 't-alpha' });
        const [terminalId, text] = broker.deliverHumanMessageToTerminalResult.mock.calls[0] as [
            string,
            string,
        ];
        expect(terminalId).toBe('t-alpha');
        expect(text).toContain('Approve the staging login');
        expect(text).toContain('signed off');
    });

    it('reports an UNDELIVERED nudge rather than rolling the resolution back', () => {
        const { db, todoId } = withUserItem();
        // Nobody is running: the resolution must still stand, and say so.
        dbMod.listTerminalSpecs.mockReturnValue([]);

        const r = resolveUserListItemOnHost({ todoId, action: 'done', comment: 'signed off' });

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.nudge.delivered).toBe(false);
        // The record really is committed — this is the half that must not be lost.
        expect(db.prepare('SELECT status FROM workspace_todos WHERE id = ?').get(todoId)).toEqual({
            status: 'done',
        });
    });

    it('ANNOUNCES the change, so every open panel re-reads without polling', () => {
        const { todoId } = withUserItem();
        alphaIsLive();
        const seen: string[] = [];
        const off = onListsChanged((ws) => seen.push(ws));

        try {
            resolveUserListItemOnHost({ todoId, action: 'done', comment: 'signed off' });
        } finally {
            off();
        }

        expect(seen).toEqual(['ws-1']);
    });

    it('announces NOTHING when the resolve was refused — nothing changed', () => {
        withUserItem();
        alphaIsLive();
        const seen: string[] = [];
        const off = onListsChanged((ws) => seen.push(ws));

        try {
            const r = resolveUserListItemOnHost({
                todoId: 'not-an-id',
                action: 'done',
                comment: 'signed off',
            });
            expect(r.ok).toBe(false);
        } finally {
            off();
        }

        expect(seen).toEqual([]);
    });
});
