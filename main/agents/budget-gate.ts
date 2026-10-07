import { budgetVerdict, isBudgetSet, type AgentBudget, type AgentSpend, type BudgetVerdict } from './budget';

/**
 * The gate a turn passes through — the only place a budget stops anything.
 *
 * Owner decisions: budgets are **per agent**, crossing one **parks the next turn and asks**,
 * and the action is itself a per-agent setting.
 *
 * ## In front of a turn, never inside one
 *
 * A turn killed halfway can lose work that is not recoverable, and an agent abandoned
 * mid-task with nobody watching is a failure mode this repository already pays for. Parking
 * the NEXT turn is the strongest intervention that cannot destroy anything, so this sits in
 * front of `session/prompt` and never interrupts one in flight.
 *
 * ## It fails OPEN
 *
 * A budget is a guard rail, not a dependency. If the settings or the telemetry cannot be
 * read, the turn is allowed: failing closed would turn a busy database into "Genie has
 * stopped running agents", which is a far worse outcome than an uncounted turn. genie#763
 * is this repository's standing reminder that a read can simply fail.
 */

export interface BudgetCrossing {
    agentId: string;
    crossed: BudgetVerdict['crossed'];
    unenforceable: BudgetVerdict['unenforceable'];
    spend: AgentSpend;
    budget: AgentBudget;
}

export interface BudgetGatePorts {
    budgetFor: (agentId: string) => AgentBudget;
    spendFor: (agentId: string) => AgentSpend;
    /** Park and ask a human — `stop-and-ask`. */
    ask: (c: BudgetCrossing) => void;
    /** Say it and carry on — `warn`, and the unenforceable-cap notice. */
    warn: (c: BudgetCrossing) => void;
    now: () => number;
}

/**
 * Agents already told about their current situation.
 *
 * An agent that keeps being prompted must not raise a question every time: the modal is the
 * most expensive thing Genie can spend, and repeating it trains people to dismiss it. Keyed
 * by agent and by WHAT was crossed, so a new cap crossing still speaks up.
 */
const told = new Map<string, string>();

/** Test seam — the module-level memo would otherwise leak between cases. */
export function resetBudgetNotices(): void {
    told.clear();
}

function noticeKey(v: BudgetVerdict): string {
    return [
        ...v.crossed.map((c) => `x:${c.cap}:${c.limit}`),
        ...v.unenforceable.map((u) => `u:${u.cap}`),
    ].join('|');
}

export interface GateResult {
    allow: boolean;
}

export function checkBudgetBeforeTurn(agentId: string, ports: BudgetGatePorts): GateResult {
    let budget: AgentBudget;
    let spend: AgentSpend;
    try {
        budget = ports.budgetFor(agentId);
        // No cap set is the state of every agent until somebody sets one — which is all of
        // them on upgrade. Read spend only when there is something to compare it against.
        if (!isBudgetSet(budget)) return { allow: true };
        spend = ports.spendFor(agentId);
    } catch {
        // Fails open, deliberately. See the note above.
        return { allow: true };
    }

    const verdict = budgetVerdict(spend, budget);
    if (verdict.kind === 'ok') return { allow: true };

    const crossing: BudgetCrossing = {
        agentId,
        crossed: verdict.crossed,
        unenforceable: verdict.unenforceable,
        spend,
        budget,
    };

    const key = noticeKey(verdict);
    const alreadyTold = told.get(agentId) === key;
    if (!alreadyTold) told.set(agentId, key);

    if (verdict.kind === 'park') {
        // Parked every time; asked once. The gate and the question are different things:
        // one protects the budget, the other spends the owner's attention.
        if (!alreadyTold) ports.ask(crossing);
        return { allow: false };
    }

    // `warn`, and `unenforceable` — a cap that is set and can never fire. Both say something
    // and allow the turn. The unenforceable one matters most: the owner believes a cost cap
    // protects a pty agent, and it cannot.
    if (!alreadyTold) ports.warn(crossing);
    return { allow: true };
}
