import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
    runMigrations,
    recordAgentUsage,
    agentSpendForDay,
    agentBudgetFor,
    setAgentBudget,
    usageEventsForDay,
} from '../db';

/**
 * Reading and writing agent telemetry, against a real database.
 *
 * The decisions these feed are pure and tested elsewhere (`agents/budget.ts`,
 * `agents/usage-rollup.ts`). What is tested HERE is the half that only a database can get
 * wrong: that a pty agent's absent cost stays absent, that one agent's spend never leaks
 * into another's budget check, and that the day boundary is the owner's, not UTC's.
 */

function fresh() {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
        `INSERT INTO workspaces (id, tynn_project_id, tynn_project_name, shape, path)
         VALUES ('ws-1', 'p', 'P', 'simple', '/tmp')`,
    ).run();
    for (const id of ['ag-1', 'ag-2']) {
        db.prepare(
            `INSERT INTO workspace_agents (id, workspace_id, name, created_at, updated_at)
             VALUES (?, 'ws-1', ?, 0, 0)`,
        ).run(id, id);
    }
    return db;
}

const DAY = '2026-10-07';
const at = new Date(2026, 9, 7, 12, 0, 0).getTime();

describe('recordAgentUsage / agentSpendForDay', () => {
    it('counts ended turns and sums declared cost', () => {
        const db = fresh();
        recordAgentUsage(db, { agentId: 'ag-1', workspaceId: 'ws-1', engine: 'acp', kind: 'turn-ended', at, durationMs: 1200, costUsd: 0.25 });
        recordAgentUsage(db, { agentId: 'ag-1', workspaceId: 'ws-1', engine: 'acp', kind: 'turn-ended', at, durationMs: 800, costUsd: 0.5 });

        const spend = agentSpendForDay(db, 'ag-1', DAY);
        expect(spend.turns).toBe(2);
        expect(spend.costUsd).toBeCloseTo(0.75, 6);
        expect(spend.engine).toBe('acp');
    });

    it('never leaks another agent’s spend into this one', () => {
        // A budget is per agent. Getting this wrong parks the wrong agent, and the owner
        // would be looking at the innocent one's settings wondering why.
        const db = fresh();
        recordAgentUsage(db, { agentId: 'ag-1', workspaceId: 'ws-1', engine: 'acp', kind: 'turn-ended', at, costUsd: 1 });
        recordAgentUsage(db, { agentId: 'ag-2', workspaceId: 'ws-1', engine: 'acp', kind: 'turn-ended', at, costUsd: 99 });
        expect(agentSpendForDay(db, 'ag-1', DAY).costUsd).toBeCloseTo(1, 6);
    });

    it('does not count YESTERDAY against today’s budget', () => {
        const db = fresh();
        const yesterday = new Date(2026, 9, 6, 12, 0, 0).getTime();
        recordAgentUsage(db, { agentId: 'ag-1', workspaceId: 'ws-1', engine: 'acp', kind: 'turn-ended', at: yesterday, costUsd: 50 });
        expect(agentSpendForDay(db, 'ag-1', DAY)).toMatchObject({ turns: 0, costUsd: 0 });
    });

    it('records a pty turn with NO cost, and reports spend of 0 for the budget check', () => {
        // Two different truths kept apart on purpose: the stored row has `cost_usd` NULL
        // (nothing was reported), while the spend handed to `budgetVerdict` is the number 0
        // plus the engine — and the engine is what makes a cost cap UNENFORCEABLE rather
        // than quietly satisfied.
        const db = fresh();
        recordAgentUsage(db, { agentId: 'ag-1', workspaceId: 'ws-1', engine: 'pty', kind: 'turn-ended', at, durationMs: 5000 });

        const stored = db
            .prepare<[string], { cost_usd: number | null }>('SELECT cost_usd FROM agent_usage_events WHERE agent_id = ?')
            .get('ag-1');
        expect(stored?.cost_usd).toBeNull();

        const spend = agentSpendForDay(db, 'ag-1', DAY);
        expect(spend).toMatchObject({ engine: 'pty', costUsd: 0, turns: 1 });
    });

    it('reports the engine of the agent’s LATEST event, so a switch is visible', () => {
        const db = fresh();
        recordAgentUsage(db, { agentId: 'ag-1', workspaceId: 'ws-1', engine: 'pty', kind: 'turn-ended', at });
        recordAgentUsage(db, { agentId: 'ag-1', workspaceId: 'ws-1', engine: 'acp', kind: 'turn-ended', at: at + 1000 });
        expect(agentSpendForDay(db, 'ag-1', DAY).engine).toBe('acp');
    });

    it('defaults an agent with no events to pty and zero, never to a crossed budget', () => {
        // A budget check on a brand-new agent must read as "nothing spent". Defaulting the
        // engine to `acp` would instead claim cost data exists for an agent that has
        // reported none.
        const db = fresh();
        expect(agentSpendForDay(db, 'ag-1', DAY)).toMatchObject({ engine: 'pty', costUsd: 0, turns: 0 });
    });

    it('stores the workstation-local day, so "today" is the owner’s day', () => {
        const db = fresh();
        const lateEvening = new Date(2026, 9, 7, 23, 30, 0).getTime();
        recordAgentUsage(db, { agentId: 'ag-1', workspaceId: 'ws-1', engine: 'acp', kind: 'turn-ended', at: lateEvening });
        expect(agentSpendForDay(db, 'ag-1', DAY).turns).toBe(1);
    });
});

describe('usageEventsForDay — the engine comparison', () => {
    it('returns a day’s events for both engines, so the rollup can separate them', () => {
        const db = fresh();
        recordAgentUsage(db, { agentId: 'ag-1', workspaceId: 'ws-1', engine: 'acp', kind: 'turn-ended', at, durationMs: 1000, costUsd: 0.1 });
        recordAgentUsage(db, { agentId: 'ag-2', workspaceId: 'ws-1', engine: 'pty', kind: 'turn-ended', at, durationMs: 9000 });

        const events = usageEventsForDay(db, DAY);
        expect(events).toHaveLength(2);
        expect(events.map((e) => e.engine).sort()).toEqual(['acp', 'pty']);
        // Cost survives as null for the pty row rather than becoming 0.
        expect(events.find((e) => e.engine === 'pty')?.costUsd).toBeNull();
    });
});

describe('agentBudgetFor / setAgentBudget', () => {
    it('reads as NO budget until one is set', () => {
        const db = fresh();
        expect(agentBudgetFor(db, 'ag-1')).toMatchObject({
            costUsdPerDay: null,
            turnsPerDay: null,
            action: 'stop-and-ask',
        });
    });

    it('round-trips a cap', () => {
        const db = fresh();
        setAgentBudget(db, 'ag-1', { costUsdPerDay: 5, turnsPerDay: 20, action: 'warn' });
        expect(agentBudgetFor(db, 'ag-1')).toMatchObject({ costUsdPerDay: 5, turnsPerDay: 20, action: 'warn' });
    });

    it('keeps a cap of ZERO, rather than discarding it as falsy', () => {
        // "This agent may not spend anything today" is a real instruction.
        const db = fresh();
        setAgentBudget(db, 'ag-1', { costUsdPerDay: 0, turnsPerDay: null, action: 'stop-and-ask' });
        expect(agentBudgetFor(db, 'ag-1').costUsdPerDay).toBe(0);
    });

    it('clears a cap when set back to null', () => {
        const db = fresh();
        setAgentBudget(db, 'ag-1', { costUsdPerDay: 5, turnsPerDay: null, action: 'stop-and-ask' });
        setAgentBudget(db, 'ag-1', { costUsdPerDay: null, turnsPerDay: null, action: 'stop-and-ask' });
        expect(agentBudgetFor(db, 'ag-1').costUsdPerDay).toBeNull();
    });

    it('REFUSES an action the code does not know', () => {
        // Validated here because the column deliberately carries no CHECK — v77's lesson.
        // A bad value must be a caught error, not a row that makes every later read
        // ambiguous.
        const db = fresh();
        expect(() =>
            setAgentBudget(db, 'ag-1', { costUsdPerDay: 1, turnsPerDay: null, action: 'explode' as never }),
        ).toThrow(/budget action/i);
    });

    it('refuses a negative cap, which can never be satisfied', () => {
        const db = fresh();
        expect(() =>
            setAgentBudget(db, 'ag-1', { costUsdPerDay: -1, turnsPerDay: null, action: 'warn' }),
        ).toThrow(/negative/i);
    });

    it('reads a stored action that predates a code change as the safe default', () => {
        // No CHECK means a hand-edited or future value can exist. Reading it as
        // `stop-and-ask` fails toward asking a human rather than toward silently not
        // enforcing.
        const db = fresh();
        db.prepare(`UPDATE workspace_agents SET budget_action = 'something-new' WHERE id = 'ag-1'`).run();
        expect(agentBudgetFor(db, 'ag-1').action).toBe('stop-and-ask');
    });
});
