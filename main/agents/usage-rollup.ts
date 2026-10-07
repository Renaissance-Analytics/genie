import type { AgentEngine } from './budget';

/**
 * Agent telemetry: the event stream, and the numbers an owner can compare.
 *
 * The ask: *"I need to be able to immediately measure any gains or losses in this new
 * infrastructure."* That is a comparison between the ACP path and the pty path, so every
 * number here is reported **per engine**. A total that mixes them answers nothing about
 * either, and is the shape this would naturally have taken.
 *
 * ## What can honestly be compared
 *
 * Declared (ACP) agents report tokens, context and cost through `usage_update`. A pty agent
 * reports **none of it** — Genie watches bytes. So:
 *
 * - **comparable on both**: turns, wall-clock per turn, human interventions
 * - **declared only**: tokens, context, cost
 *
 * A pty agent's cost is therefore `null` — "cannot see" — and never `0`. Summing it as zero
 * would make the old path look free and the new one expensive, which is precisely the wrong
 * conclusion to hand somebody deciding whether to keep going.
 */

/** One recorded fact. Append-only; `day` is stored at write time, see `localDayKey`. */
export interface AgentUsageEvent {
    agentId: string;
    engine: AgentEngine;
    kind:
        | 'turn-started'
        | 'turn-ended'
        | 'tool-call'
        | 'approval-asked'
        | 'approval-decided'
        | 'question-asked'
        | 'restarted'
        | 'compacted';
    /** Epoch ms. */
    at: number;
    /** `YYYY-MM-DD`, workstation-local. */
    day: string;
    /** Only on `turn-ended`. */
    durationMs: number | null;
    /** USD, declared agents only. `null` means not reported, never "free". */
    costUsd: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
}

/** What a human had to be pulled in for. Observable on both engines, which is why it is
 *  the most useful single measure of whether the new path is actually better. */
const INTERVENTIONS: ReadonlySet<AgentUsageEvent['kind']> = new Set([
    'approval-asked',
    'question-asked',
]);

export interface EngineTotals {
    turns: number;
    /** `null` when nothing reported cost — not zero. */
    costUsd: number | null;
    /** `null` when no turn has ended yet. */
    meanTurnMs: number | null;
    interventions: number;
    tokensIn: number | null;
    tokensOut: number | null;
}

/** One agent's spend in the window, shaped for `budgetVerdict`. */
export interface AgentSpendRow {
    engine: AgentEngine;
    /** A NUMBER here, 0 for pty. `budgetVerdict` decides enforceability from the engine,
     *  which is what turns a pty cost cap into "unenforceable" rather than "satisfied". */
    costUsd: number;
    turns: number;
}

export interface UsageRollup {
    byEngine: Record<AgentEngine, EngineTotals>;
    byAgent: Record<string, AgentSpendRow | undefined>;
}

/**
 * The workstation-local calendar day, as `YYYY-MM-DD`.
 *
 * Stored on each row at WRITE time rather than derived at query time. SQLite has no
 * timezone, so a rollup computed from epoch groups by UTC and cuts the day at the wrong
 * hour for every zone but one — making "today" on the Deck mean something the owner did not
 * mean. Writing it once, locally, also makes the daily rollup a plain indexed equality.
 */
export function localDayKey(at: number): string {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const emptyTotals = (): EngineTotals => ({
    turns: 0,
    costUsd: null,
    meanTurnMs: null,
    interventions: 0,
    tokensIn: null,
    tokensOut: null,
});

/** Add to a sum that starts as `null`, so "nothing reported" stays distinct from zero. */
const addNullable = (sum: number | null, v: number | null): number | null =>
    v === null ? sum : (sum ?? 0) + v;

export function rollUpUsage(events: readonly AgentUsageEvent[]): UsageRollup {
    const byEngine: Record<AgentEngine, EngineTotals> = { acp: emptyTotals(), pty: emptyTotals() };
    const durations: Record<AgentEngine, number[]> = { acp: [], pty: [] };
    const byAgent: Record<string, AgentSpendRow | undefined> = {};
    /** Latest event time per agent, so an engine switch resolves to what it runs under NOW. */
    const latestAt: Record<string, number> = {};

    for (const e of events) {
        const totals = byEngine[e.engine];

        if (e.kind === 'turn-ended') {
            totals.turns += 1;
            // A turn still running carries no duration. Counting it as 0 would halve the
            // mean and flatter whichever engine happened to be mid-turn at read time.
            if (e.durationMs !== null) durations[e.engine].push(e.durationMs);
        }
        if (INTERVENTIONS.has(e.kind)) totals.interventions += 1;

        totals.costUsd = addNullable(totals.costUsd, e.costUsd);
        totals.tokensIn = addNullable(totals.tokensIn, e.tokensIn);
        totals.tokensOut = addNullable(totals.tokensOut, e.tokensOut);

        const row = byAgent[e.agentId] ?? { engine: e.engine, costUsd: 0, turns: 0 };
        if (e.at >= (latestAt[e.agentId] ?? Number.NEGATIVE_INFINITY)) {
            row.engine = e.engine;
            latestAt[e.agentId] = e.at;
        }
        row.costUsd += e.costUsd ?? 0;
        if (e.kind === 'turn-ended') row.turns += 1;
        byAgent[e.agentId] = row;
    }

    for (const engine of ['acp', 'pty'] as const) {
        const d = durations[engine];
        byEngine[engine].meanTurnMs = d.length === 0 ? null : d.reduce((a, b) => a + b, 0) / d.length;
    }
    return { byEngine, byAgent };
}
