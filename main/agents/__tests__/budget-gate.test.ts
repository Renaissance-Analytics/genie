import { describe, expect, it, vi } from 'vitest';
import { beforeEach } from 'vitest';
import { checkBudgetBeforeTurn, resetBudgetNotices, type BudgetGatePorts } from '../budget-gate';

/**
 * The gate a turn passes through, and the only place a budget stops anything.
 *
 * Owner decisions: budgets are **per agent**, crossing one **parks the next turn and asks**,
 * and the action is itself a per-agent setting.
 *
 * ## Why it is checked HERE and not mid-turn
 *
 * A turn killed halfway can lose work that is not recoverable, and an agent abandoned
 * mid-task with nobody watching is a failure mode this repository already pays for
 * elsewhere. Parking the NEXT turn is the strongest intervention that cannot destroy
 * anything — so the gate sits in front of `session/prompt` and never interrupts one in
 * flight.
 *
 * ## Why it asks instead of just refusing
 *
 * A budget that silently stops an agent looks exactly like Genie being broken. The whole
 * value of `stop-and-ask` is that the owner finds out, from the agent that is parked, with
 * the numbers that parked it.
 */

beforeEach(() => resetBudgetNotices());

const ports = (over: Partial<BudgetGatePorts> = {}): BudgetGatePorts => ({
    budgetFor: () => ({ costUsdPerDay: null, turnsPerDay: null, action: 'stop-and-ask' }),
    spendFor: () => ({ engine: 'acp', costUsd: 0, turns: 0 }),
    ask: vi.fn(),
    warn: vi.fn(),
    now: () => 1_700_000_000_000,
    ...over,
});

describe('checkBudgetBeforeTurn — the common case', () => {
    it('ALLOWS when the agent has no budget, asking nothing', () => {
        // Every agent until somebody sets a cap, which is all of them on upgrade. The gate
        // must be inert and silent, or a release would read as Genie suddenly interrogating
        // people about agents they never configured.
        const p = ports();
        expect(checkBudgetBeforeTurn('ag-1', p)).toMatchObject({ allow: true });
        expect(p.ask).not.toHaveBeenCalled();
        expect(p.warn).not.toHaveBeenCalled();
    });

    it('ALLOWS while the agent is under its cap', () => {
        const p = ports({
            budgetFor: () => ({ costUsdPerDay: 5, turnsPerDay: null, action: 'stop-and-ask' }),
            spendFor: () => ({ engine: 'acp', costUsd: 1.2, turns: 3 }),
        });
        expect(checkBudgetBeforeTurn('ag-1', p).allow).toBe(true);
        expect(p.ask).not.toHaveBeenCalled();
    });
});

describe('checkBudgetBeforeTurn — crossing a cap', () => {
    it('PARKS the turn and asks, naming the cap and the numbers', () => {
        const p = ports({
            budgetFor: () => ({ costUsdPerDay: 5, turnsPerDay: null, action: 'stop-and-ask' }),
            spendFor: () => ({ engine: 'acp', costUsd: 5.5, turns: 9 }),
        });
        const verdict = checkBudgetBeforeTurn('ag-1', p);

        expect(verdict.allow).toBe(false);
        expect(p.ask).toHaveBeenCalledTimes(1);
        // The question has to carry what crossed and by how much. "Over budget" with no
        // number sends somebody to change the wrong setting.
        const asked = vi.mocked(p.ask).mock.calls[0]![0];
        expect(asked.agentId).toBe('ag-1');
        expect(asked.crossed).toEqual([{ cap: 'costUsd', limit: 5, actual: 5.5 }]);
    });

    it('WARNS and still ALLOWS when that is the agent’s configured action', () => {
        // The per-agent setting. A warn-only agent keeps working and says so.
        const p = ports({
            budgetFor: () => ({ costUsdPerDay: 5, turnsPerDay: null, action: 'warn' }),
            spendFor: () => ({ engine: 'acp', costUsd: 9, turns: 2 }),
        });
        const verdict = checkBudgetBeforeTurn('ag-1', p);

        expect(verdict.allow).toBe(true);
        expect(p.warn).toHaveBeenCalledTimes(1);
        expect(p.ask).not.toHaveBeenCalled();
    });

    it('asks ONCE per crossing, not once per attempted turn', () => {
        // An agent that keeps being prompted must not raise a question every time. The
        // modal is the most expensive thing Genie can spend; repeating it would train
        // people to dismiss it.
        const p = ports({
            budgetFor: () => ({ costUsdPerDay: 5, turnsPerDay: null, action: 'stop-and-ask' }),
            spendFor: () => ({ engine: 'acp', costUsd: 6, turns: 1 }),
        });
        checkBudgetBeforeTurn('ag-1', p);
        checkBudgetBeforeTurn('ag-1', p);
        checkBudgetBeforeTurn('ag-1', p);
        expect(p.ask).toHaveBeenCalledTimes(1);
        // Still parked every time, though — asking once is about the question, not the gate.
        expect(checkBudgetBeforeTurn('ag-1', p).allow).toBe(false);
    });

    it('asks again for a DIFFERENT agent', () => {
        const p = ports({
            budgetFor: () => ({ costUsdPerDay: 5, turnsPerDay: null, action: 'stop-and-ask' }),
            spendFor: () => ({ engine: 'acp', costUsd: 6, turns: 1 }),
        });
        checkBudgetBeforeTurn('ag-1', p);
        checkBudgetBeforeTurn('ag-2', p);
        expect(p.ask).toHaveBeenCalledTimes(2);
    });
});

describe('checkBudgetBeforeTurn — a cap that cannot bind', () => {
    it('ALLOWS a pty agent whose only cap is on cost, and says why ONCE', () => {
        // The honest case. A pty agent reports no cost, so the cap can never fire — and the
        // owner believes they are protected. It must not park (the cap is not crossed, and
        // never will be) and it must not be silent.
        const p = ports({
            budgetFor: () => ({ costUsdPerDay: 5, turnsPerDay: null, action: 'stop-and-ask' }),
            spendFor: () => ({ engine: 'pty', costUsd: 0, turns: 40 }),
        });
        const verdict = checkBudgetBeforeTurn('ag-1', p);

        expect(verdict.allow).toBe(true);
        expect(p.ask).not.toHaveBeenCalled();
        expect(p.warn).toHaveBeenCalledTimes(1);
        const warned = vi.mocked(p.warn).mock.calls[0]![0];
        expect(warned.unenforceable[0]?.because).toMatch(/pty agent reports no cost/i);
    });

    it('still PARKS a pty agent on a turn cap, which does bind it', () => {
        // One unenforceable cap must not take a working cap down with it.
        const p = ports({
            budgetFor: () => ({ costUsdPerDay: 5, turnsPerDay: 20, action: 'stop-and-ask' }),
            spendFor: () => ({ engine: 'pty', costUsd: 0, turns: 20 }),
        });
        expect(checkBudgetBeforeTurn('ag-1', p).allow).toBe(false);
        expect(p.ask).toHaveBeenCalledTimes(1);
    });
});

describe('checkBudgetBeforeTurn — failure must not block work', () => {
    it('ALLOWS the turn when the budget cannot be read', () => {
        // A telemetry or settings failure must never stop an agent working. The gate is a
        // guard rail, not a dependency: failing closed would turn a bad database read into
        // "Genie has stopped running agents".
        const p = ports({
            budgetFor: () => {
                throw new Error('db is busy');
            },
        });
        expect(checkBudgetBeforeTurn('ag-1', p).allow).toBe(true);
    });

    it('ALLOWS the turn when spend cannot be read', () => {
        const p = ports({
            budgetFor: () => ({ costUsdPerDay: 5, turnsPerDay: null, action: 'stop-and-ask' }),
            spendFor: () => {
                throw new Error('db is busy');
            },
        });
        expect(checkBudgetBeforeTurn('ag-1', p).allow).toBe(true);
    });
});
