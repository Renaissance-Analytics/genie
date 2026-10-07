/**
 * Per-agent budgets, decided as a value.
 *
 * Owner decisions 2026-10-07: budgets are set **per agent**; crossing one **parks the next
 * turn and asks** rather than killing anything; the action is itself a per-agent setting.
 * The window is the calendar day, workstation-local.
 *
 * ## Why this is a module and not two comparisons
 *
 * Genie only has cost data for **declared (ACP)** agents — `usage_update` carries tokens,
 * context and cost. A **pty** agent reports none, which is why the Agent view renders
 * nothing rather than a dash in its cost cell.
 *
 * So a cost cap on a pty agent is a cap that **can never fire**: spend reads as `0` forever.
 * The dangerous version of this feature accepts the number, shows it in settings, and
 * silently never enforces it — the owner believes they are protected and they are not. This
 * reports such a cap as `unenforceable`, naming it, rather than returning `ok`.
 *
 * That is the rule the session model already holds to: `null` means "cannot see" and may
 * never read as "none".
 *
 * ## Why it parks rather than kills
 *
 * The verdict is consulted at a TURN BOUNDARY. Nothing is interrupted mid-turn, because a
 * turn killed halfway can lose work that is not recoverable — and an agent abandoned
 * mid-task with nobody watching is a failure mode this repo already pays for. Parking the
 * NEXT turn is the strongest intervention that cannot destroy anything.
 */

/** Which transport the agent is running under. Decides what Genie can even measure. */
export type AgentEngine = 'acp' | 'pty';

/** What the agent has consumed in the current window. */
export interface AgentSpend {
    engine: AgentEngine;
    /** USD. Always 0 for a pty agent, because none is reported — see the note above. */
    costUsd: number;
    /** Turns Genie has counted. Observable on BOTH engines. */
    turns: number;
}

/** A per-agent cap. `null` is "no cap", which is NOT the same as a cap of zero. */
export interface AgentBudget {
    costUsdPerDay: number | null;
    turnsPerDay: number | null;
    /** What crossing does. Per-agent, per the owner's note on the enforcement decision. */
    action: 'warn' | 'stop-and-ask';
}

/** Which cap, its limit, and what was actually spent. */
export interface CrossedCap {
    cap: 'costUsd' | 'turns';
    limit: number;
    actual: number;
}

/** A cap that is set but cannot bind this engine, and why — in words a human can act on. */
export interface UnenforceableCap {
    cap: 'costUsd' | 'turns';
    because: string;
}

export interface BudgetVerdict {
    /**
     * - `ok` — under every cap that can bind.
     * - `warn` — a cap is crossed and this agent's action is to say so only.
     * - `park` — a cap is crossed and the next turn must not start.
     * - `unenforceable` — a cap is SET, nothing is crossed, and at least one cap cannot
     *   bind this engine. Deliberately not `ok`: the honest answer is "you are not
     *   protected the way you think".
     */
    kind: 'ok' | 'warn' | 'park' | 'unenforceable';
    crossed: CrossedCap[];
    unenforceable: UnenforceableCap[];
    /** Headroom per cap, so a surface can warn before the wall rather than at it. */
    remaining: { costUsd: number | null; turns: number | null };
}

/** Whether this agent has any cap at all. Zero counts: "may not spend anything" is a cap. */
export function isBudgetSet(b: AgentBudget): boolean {
    return b.costUsdPerDay !== null || b.turnsPerDay !== null;
}

/**
 * Decide where this agent stands against its budget.
 *
 * AT the cap counts as crossed, not only over it: the next turn would spend past the limit,
 * and the point is to stop before that rather than report it afterwards.
 */
export function budgetVerdict(spend: AgentSpend, b: AgentBudget): BudgetVerdict {
    const crossed: CrossedCap[] = [];
    const unenforceable: UnenforceableCap[] = [];

    // A cost cap needs cost data, and only a declared agent reports any.
    const costCanBind = spend.engine === 'acp';

    if (b.costUsdPerDay !== null) {
        if (!costCanBind) {
            unenforceable.push({
                cap: 'costUsd',
                because: 'a pty agent reports no cost to Genie',
            });
        } else if (spend.costUsd >= b.costUsdPerDay) {
            crossed.push({ cap: 'costUsd', limit: b.costUsdPerDay, actual: spend.costUsd });
        }
    }

    // Turns are counted by Genie itself, so this cap binds either engine.
    if (b.turnsPerDay !== null && spend.turns >= b.turnsPerDay) {
        crossed.push({ cap: 'turns', limit: b.turnsPerDay, actual: spend.turns });
    }

    const remaining = {
        costUsd: b.costUsdPerDay !== null && costCanBind ? b.costUsdPerDay - spend.costUsd : null,
        turns: b.turnsPerDay !== null ? b.turnsPerDay - spend.turns : null,
    };

    // A real crossing outranks an unenforceable cap: one working cap must still stop work
    // even when another cap alongside it cannot bind.
    if (crossed.length > 0) {
        return { kind: b.action === 'warn' ? 'warn' : 'park', crossed, unenforceable, remaining };
    }
    if (unenforceable.length > 0) {
        return { kind: 'unenforceable', crossed, unenforceable, remaining };
    }
    return { kind: 'ok', crossed, unenforceable, remaining };
}
