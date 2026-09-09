import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
    createWorkspaceTodo,
    listAgentTodos,
    listWorkspaceTodos,
    runMigrations,
} from '../db';

/**
 * v76 — an AgentList belongs to ONE AGENT, and it is keyed by the agent's NAME.
 *
 * v51 shipped `workspace_todos` with a `kind IN ('user','agent')` column and
 * never wired it to anything. Two things in it are wrong for the list feature
 * genie#556 builds on top of it, and both are load-bearing:
 *
 *  - The `agent` cap counted open rows per (workspace_id, kind), so every agent
 *    in a workspace shared ONE ten-item budget. The contract is one list per
 *    agent; with three agents running, the third could be refused its first
 *    item because the other two had been busy.
 *
 *  - `agent_id` FKs to `workspace_agents(id)`, which only `registerAgent` ever
 *    creates, and which `main/agents/agent-mode-source.ts` documents as a
 *    DIFFERENT id from the AgentInbox agent id that `spawnTerminal` re-mints on
 *    every launch. A list that has to survive a restart can key on neither.
 *    `main/agents/handoff.ts` already settled this for the handoff note — "one
 *    file per AGENT NAME, not per terminal" — so the list keys the same way
 *    rather than inventing a fourth identity.
 */

function tables(d: Database.Database): Set<string> {
    return new Set(
        d
            .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all()
            .map((r) => r.name),
    );
}

function cols(d: Database.Database, table: string): Set<string> {
    return new Set(
        d
            .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
            .all()
            .map((r) => r.name),
    );
}

function seeded(upTo?: number): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db, upTo === undefined ? {} : { upTo });
    db.prepare(
        `INSERT INTO workspaces
            (id, tynn_project_id, tynn_project_name, project_id, project_name,
             shape, path, sort_order)
         VALUES ('ws-1', 'p-1', 'One', 'p-1', 'One', 'simple', '/tmp/one', 0)`,
    ).run();
    return db;
}

describe('v76 — the agent_name column', () => {
    it('does not exist before v76 (positive control: the db is otherwise migrated)', () => {
        const d = seeded(75);
        // The negative below would also pass against an empty database, so pin
        // that the migrations really did run up to 75.
        expect(tables(d).has('workspace_todos')).toBe(true);
        expect(cols(d, 'workspace_todos').has('agent_name')).toBe(false);
    });

    it('exists after v76, alongside the columns v51 already had', () => {
        const d = seeded();
        const c = cols(d, 'workspace_todos');
        expect(c.has('agent_name')).toBe(true);
        for (const column of ['id', 'workspace_id', 'kind', 'text', 'status']) {
            expect(c.has(column), column).toBe(true);
        }
    });
});

describe('the AgentList cap is per AGENT, not per workspace', () => {
    it('gives each agent in one workspace its own ten items', () => {
        const db = seeded();
        for (let i = 0; i < 10; i++) {
            expect(
                createWorkspaceTodo(db, {
                    workspaceId: 'ws-1',
                    kind: 'agent',
                    agentName: 'alpha',
                    text: `a${i}`,
                }).ok,
                `alpha item ${i}`,
            ).toBe(true);
        }
        // alpha is full...
        expect(
            createWorkspaceTodo(db, {
                workspaceId: 'ws-1',
                kind: 'agent',
                agentName: 'alpha',
                text: 'overflow',
            }),
        ).toMatchObject({ ok: false, cap: 10 });

        // ...but beta, in the SAME workspace, is untouched. This is the whole
        // point of the change: under v51 this first item was refused.
        expect(
            createWorkspaceTodo(db, {
                workspaceId: 'ws-1',
                kind: 'agent',
                agentName: 'beta',
                text: 'b0',
            }).ok,
        ).toBe(true);
    });

    it('TELLS the agent when the eleventh item is refused, and drops nothing', () => {
        const db = seeded();
        for (let i = 0; i < 10; i++) {
            createWorkspaceTodo(db, {
                workspaceId: 'ws-1',
                kind: 'agent',
                agentName: 'alpha',
                text: `a${i}`,
            });
        }
        const refused = createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'agent',
            agentName: 'alpha',
            text: 'overflow',
        });
        expect(refused.ok).toBe(false);
        if (refused.ok) throw new Error('expected a refusal');
        // A silent drop loses work and a refusal the agent cannot read is just
        // as bad, so the error has to name the cap.
        expect(refused.error).toContain('10');
        expect(refused.cap).toBe(10);

        // The oldest item is still there — nothing was evicted to make room.
        const open = listAgentTodos(db, 'ws-1', 'alpha');
        expect(open).toHaveLength(10);
        expect(open[0]?.text).toBe('a0');
        expect(open.some((t) => t.text === 'overflow')).toBe(false);
    });

    it('scopes an agent list by workspace as well as by name', () => {
        const db = seeded();
        db.prepare(
            `INSERT INTO workspaces
                (id, tynn_project_id, tynn_project_name, project_id, project_name,
                 shape, path, sort_order)
             VALUES ('ws-2', 'p-2', 'Two', 'p-2', 'Two', 'simple', '/tmp/two', 1)`,
        ).run();
        createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'agent',
            agentName: 'alpha',
            text: 'here',
        });
        createWorkspaceTodo(db, {
            workspaceId: 'ws-2',
            kind: 'agent',
            agentName: 'alpha',
            text: 'there',
        });

        expect(listAgentTodos(db, 'ws-1', 'alpha').map((t) => t.text)).toEqual(['here']);
        expect(listAgentTodos(db, 'ws-2', 'alpha').map((t) => t.text)).toEqual(['there']);
    });

    it('keeps ONE user list per workspace, shared by every agent that writes to it', () => {
        const db = seeded();
        // Two different agents adding to the workspace's single user list.
        createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'alpha',
            text: 'u-a',
        });
        createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'user',
            agentName: 'beta',
            text: 'u-b',
        });

        const list = listWorkspaceTodos(db, 'ws-1', 'user');
        expect(list.map((t) => t.text)).toEqual(['u-a', 'u-b']);
        // Each item still records WHO asked, because that is who gets nudged.
        expect(list.map((t) => t.agent_name)).toEqual(['alpha', 'beta']);
    });

    it('refuses a list item with no agent name — every item belongs to an agent', () => {
        const db = seeded();
        const r = createWorkspaceTodo(db, {
            workspaceId: 'ws-1',
            kind: 'agent',
            agentName: '   ',
            text: 'orphan',
        });
        expect(r.ok).toBe(false);
        // Positive control: the same call with a name succeeds, so the refusal
        // above is about the name and not about the text or the workspace.
        expect(
            createWorkspaceTodo(db, {
                workspaceId: 'ws-1',
                kind: 'agent',
                agentName: 'alpha',
                text: 'orphan',
            }).ok,
        ).toBe(true);
    });
});
