import { describe, expect, it } from 'vitest';
import {
    budgetVerdict,
    isBudgetSet,
    type AgentBudget,
    type AgentSpend,
} from '../budget';

/**
 * Per-agent budgets, decided as a value.
 *
 * Owner decisions 2026-10-07: budgets are set **per agent**; crossing one **parks the next
 * turn and asks** rather than killing anything; and the action is itself a per-agent
 * setting. Window is the calendar day, workstation-local.
 *
 * ## The thing this module exists to get right
 *
 * Genie only has cost data for **declared (ACP)** agents — `usage_update` carries tokens,
 * context and cost. A **pty** agent reports none at all, which is why the Agent view renders
 * nothing rather than a dash in a cost cell for one.
 *
 * So a cost cap on a pty agent is a cap that **can never fire**. The dangerous version of
 * this feature is the one that accepts the number, shows it in settings, and quietly never
 * enforces it — the owner believes they are protected and they are not. This module reports
 * such a cap as UNENFORCEABLE, by name, rather than returning `ok`.
 *
 * That is the same rule the session model already holds to: `null` means "cannot see" and is
 * never allowed to read as "none".
 */

const budget = (over: Partial<AgentBudget> = {}): AgentBudget => ({
    costUsdPerDay: null,
    turnsPerDay: null,
    action: 'stop-and-ask',
    ...over,
});

const spend = (over: Partial<AgentSpend> = {}): AgentSpend => ({
    engine: 'acp',
    costUsd: 0,
    turns: 0,
    ...over,
});

describe('isBudgetSet', () => {
    it('is false when no cap is set, so nothing is enforced', () => {
        // Not "a budget of zero". An unset cap must never park an agent, which is the
        // difference between a feature nobody configured and one that stops all work.
        expect(isBudgetSet(budget())).toBe(false);
    });

    it('is true as soon as one cap has a number', () => {
        expect(isBudgetSet(budget({ costUsdPerDay: 5 }))).toBe(true);
        expect(isBudgetSet(budget({ turnsPerDay: 20 }))).toBe(true);
    });

    it('treats zero as SET, because zero is a real cap', () => {
        // "This agent may not spend anything today" is a legitimate instruction, and
        // falsy-checking a cap would silently discard it.
        expect(isBudgetSet(budget({ costUsdPerDay: 0 }))).toBe(true);
    });
});

describe('budgetVerdict — under the cap', () => {
    it('is ok when nothing is set', () => {
        expect(budgetVerdict(spend(), budget())).toMatchObject({ kind: 'ok' });
    });

    it('is ok while spend is below every cap', () => {
        const v = budgetVerdict(spend({ costUsd: 2.5, turns: 4 }), budget({ costUsdPerDay: 5, turnsPerDay: 20 }));
        expect(v).toMatchObject({ kind: 'ok' });
        expect(v.crossed).toEqual([]);
    });

    it('reports how much headroom is left, so a surface can warn before the wall', () => {
        const v = budgetVerdict(spend({ costUsd: 4, turns: 0 }), budget({ costUsdPerDay: 5 }));
        expect(v.remaining).toMatchObject({ costUsd: 1 });
    });
});

describe('budgetVerdict — at or over the cap', () => {
    it('parks when cost reaches the cap, not only when it exceeds it', () => {
        // AT the cap is over budget: the next turn would spend past it, and the whole point
        // is to stop before that rather than after.
        const v = budgetVerdict(spend({ costUsd: 5 }), budget({ costUsdPerDay: 5 }));
        expect(v.kind).toBe('park');
        expect(v.crossed).toEqual([{ cap: 'costUsd', limit: 5, actual: 5 }]);
    });

    it('parks when the turn count reaches its cap', () => {
        const v = budgetVerdict(spend({ turns: 20 }), budget({ turnsPerDay: 20 }));
        expect(v.kind).toBe('park');
        expect(v.crossed).toEqual([{ cap: 'turns', limit: 20, actual: 20 }]);
    });

    it('names EVERY cap crossed, not just the first', () => {
        // A surface that says "over budget" without saying which number is a surface that
        // sends somebody to change the wrong setting.
        const v = budgetVerdict(
            spend({ costUsd: 9, turns: 30 }),
            budget({ costUsdPerDay: 5, turnsPerDay: 20 }),
        );
        expect(v.crossed.map((c) => c.cap).sort()).toEqual(['costUsd', 'turns']);
    });

    it('WARNS instead of parking when that is the agent’s configured action', () => {
        const v = budgetVerdict(spend({ costUsd: 9 }), budget({ costUsdPerDay: 5, action: 'warn' }));
        expect(v.kind).toBe('warn');
        // Still reports what was crossed: warn is about what happens NEXT, not about
        // knowing less.
        expect(v.crossed).toEqual([{ cap: 'costUsd', limit: 5, actual: 9 }]);
    });

    it('parks a zero-cost cap on the first spend', () => {
        expect(budgetVerdict(spend({ costUsd: 0.01 }), budget({ costUsdPerDay: 0 })).kind).toBe('park');
    });
});

describe('budgetVerdict — a cap that CANNOT bind this engine', () => {
    /**
     * The honest half, and the reason this is a module rather than two comparisons.
     *
     * A pty agent reports no cost. A cost cap on one is unenforceable: it will read as
     * `costUsd: 0` forever and never fire. Returning `ok` there would be a lie with a
     * number attached.
     */
    it('reports a cost cap on a PTY agent as unenforceable rather than ok', () => {
        const v = budgetVerdict(spend({ engine: 'pty', costUsd: 0 }), budget({ costUsdPerDay: 5 }));
        expect(v.kind).toBe('unenforceable');
        expect(v.unenforceable).toEqual([
            { cap: 'costUsd', because: 'a pty agent reports no cost to Genie' },
        ]);
    });

    it('still enforces the caps that DO bind a pty agent', () => {
        // Turns are counted by Genie either way, so a turn cap binds both engines. An
        // unenforceable cost cap must not take the working turn cap down with it.
        const v = budgetVerdict(
            spend({ engine: 'pty', turns: 20 }),
            budget({ costUsdPerDay: 5, turnsPerDay: 20 }),
        );
        expect(v.kind).toBe('park');
        expect(v.crossed).toEqual([{ cap: 'turns', limit: 20, actual: 20 }]);
        // And it still says the other one cannot be honoured.
        expect(v.unenforceable.map((u) => u.cap)).toEqual(['costUsd']);
    });

    it('says nothing is unenforceable for a DECLARED agent', () => {
        // The positive control. If this ever reported `unenforceable` for ACP, every cost
        // budget in the product would be silently off while claiming to be on.
        const v = budgetVerdict(spend({ engine: 'acp', costUsd: 1 }), budget({ costUsdPerDay: 5 }));
        expect(v.unenforceable).toEqual([]);
        expect(v.kind).toBe('ok');
    });

    it('is plain `ok` for a pty agent with no cost cap set', () => {
        // Unenforceability is about a cap that EXISTS and cannot bind — not about an engine
        // being less observable in general. Reporting it otherwise would make every pty
        // agent permanently warn about a budget nobody set.
        const v = budgetVerdict(spend({ engine: 'pty', turns: 2 }), budget({ turnsPerDay: 20 }));
        expect(v).toMatchObject({ kind: 'ok' });
        expect(v.unenforceable).toEqual([]);
    });
});
