import { describe, expect, it } from 'vitest';
import { localDayKey, rollUpUsage, type AgentUsageEvent } from '../usage-rollup';

/**
 * Turning the raw event stream into the numbers an owner can compare.
 *
 * The ask: *"I need to be able to immediately measure any gains or losses in this new
 * infrastructure."* That is a comparison between the ACP path and the pty path, so the
 * rollup's whole job is to keep the two **separable** — a total that mixes engines answers
 * nothing about either.
 *
 * ## What can honestly be compared
 *
 * | | declared (ACP) | pty |
 * |---|---|---|
 * | turns, wall-clock, interventions | yes | yes |
 * | tokens / context / cost | yes (`usage_update`) | **nothing reported** |
 *
 * So the comparable axes are turns, duration and how often a human had to step in. Cost
 * exists on one side only, and the rollup must not imply otherwise: a pty agent's cost is
 * `null` ("cannot see"), never `0` ("spent nothing"). Summing it as zero would make the new
 * engine look expensive next to a free one, which is exactly the wrong conclusion.
 */

const ev = (over: Partial<AgentUsageEvent> = {}): AgentUsageEvent => ({
    agentId: 'agent-1',
    engine: 'acp',
    kind: 'turn-ended',
    at: 1_700_000_000_000,
    day: '2026-10-07',
    durationMs: 1_000,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    ...over,
});

describe('localDayKey', () => {
    it('is the WORKSTATION-local calendar day, so "today" means what the owner means', () => {
        // Stored at write time rather than derived at query time: SQLite has no timezone,
        // so a rollup computed from epoch would silently group by UTC and cut the day at
        // the wrong hour for everyone west of Greenwich.
        const noon = new Date(2026, 9, 7, 12, 0, 0); // 7 Oct 2026, local
        expect(localDayKey(noon.getTime())).toBe('2026-10-07');
    });

    it('does not roll over at UTC midnight', () => {
        // The case that proves the point. 23:30 local on the 7th is the 7th, whatever UTC
        // says — and in a UTC+ zone it would already be the 8th.
        const lateEvening = new Date(2026, 9, 7, 23, 30, 0);
        expect(localDayKey(lateEvening.getTime())).toBe('2026-10-07');
    });

    it('zero-pads, so keys sort lexically', () => {
        expect(localDayKey(new Date(2026, 0, 5, 9, 0, 0).getTime())).toBe('2026-01-05');
    });
});

describe('rollUpUsage — keeping the engines separable', () => {
    it('reports each engine on its own, never a merged total', () => {
        const r = rollUpUsage([
            ev({ engine: 'acp', kind: 'turn-ended', durationMs: 2_000, costUsd: 0.5 }),
            ev({ engine: 'pty', kind: 'turn-ended', durationMs: 8_000 }),
        ]);
        expect(r.byEngine.acp.turns).toBe(1);
        expect(r.byEngine.pty.turns).toBe(1);
    });

    it('keeps a pty agent’s cost NULL, not zero', () => {
        // The load-bearing one. Zero would read as "the old way was free" and make every
        // comparison favour it.
        const r = rollUpUsage([ev({ engine: 'pty', kind: 'turn-ended', costUsd: null })]);
        expect(r.byEngine.pty.costUsd).toBeNull();
        expect(r.byEngine.acp.costUsd).toBeNull(); // no acp events at all: also unknown
    });

    it('sums cost for declared agents, which DO report it', () => {
        const r = rollUpUsage([
            ev({ engine: 'acp', costUsd: 0.25 }),
            ev({ engine: 'acp', costUsd: 0.75 }),
        ]);
        expect(r.byEngine.acp.costUsd).toBeCloseTo(1, 6);
    });

    it('averages turn duration per engine — the axis that compares honestly', () => {
        const r = rollUpUsage([
            ev({ engine: 'acp', durationMs: 1_000 }),
            ev({ engine: 'acp', durationMs: 3_000 }),
            ev({ engine: 'pty', durationMs: 10_000 }),
        ]);
        expect(r.byEngine.acp.meanTurnMs).toBe(2_000);
        expect(r.byEngine.pty.meanTurnMs).toBe(10_000);
    });

    it('counts human interventions, which is the real usability measure', () => {
        // Whether the new infrastructure is BETTER is mostly "did a person have to step in
        // less often", and that is observable on both engines.
        const r = rollUpUsage([
            ev({ engine: 'acp', kind: 'question-asked' }),
            ev({ engine: 'acp', kind: 'approval-asked' }),
            ev({ engine: 'pty', kind: 'question-asked' }),
        ]);
        expect(r.byEngine.acp.interventions).toBe(2);
        expect(r.byEngine.pty.interventions).toBe(1);
    });

    it('ignores a turn that has not ended when averaging duration', () => {
        // `turn-started` carries no duration. Counting it as 0 would halve the mean and
        // make whichever engine was mid-turn at read time look faster.
        const r = rollUpUsage([
            ev({ engine: 'acp', kind: 'turn-ended', durationMs: 4_000 }),
            ev({ engine: 'acp', kind: 'turn-started', durationMs: null }),
        ]);
        expect(r.byEngine.acp.meanTurnMs).toBe(4_000);
        expect(r.byEngine.acp.turns).toBe(1);
    });

    it('is all-null and zero for an empty stream, rather than throwing', () => {
        // The first day of a fresh install reads this.
        const r = rollUpUsage([]);
        expect(r.byEngine.acp).toMatchObject({ turns: 0, costUsd: null, meanTurnMs: null, interventions: 0 });
        expect(r.byEngine.pty).toMatchObject({ turns: 0, costUsd: null, meanTurnMs: null, interventions: 0 });
    });
});

describe('rollUpUsage — the per-agent spend a budget is checked against', () => {
    it('totals one agent’s spend for the window', () => {
        const r = rollUpUsage([
            ev({ agentId: 'a', engine: 'acp', costUsd: 1.5 }),
            ev({ agentId: 'a', engine: 'acp', costUsd: 1.0 }),
            ev({ agentId: 'b', engine: 'acp', costUsd: 9.0 }),
        ]);
        expect(r.byAgent.a).toMatchObject({ engine: 'acp', turns: 2 });
        expect(r.byAgent.a!.costUsd).toBeCloseTo(2.5, 6);
        // Another agent's spend must never leak into this one's budget check.
        expect(r.byAgent.b!.costUsd).toBeCloseTo(9, 6);
    });

    it('reports a pty agent’s spend with cost 0, which is what the budget check needs', () => {
        // Deliberately different from the comparison view above. `budgetVerdict` takes a
        // NUMBER and decides enforceability from the engine, so the per-agent spend hands
        // it 0 plus the engine — and the engine is what makes a cost cap unenforceable
        // rather than silently satisfied.
        const r = rollUpUsage([ev({ agentId: 'a', engine: 'pty', kind: 'turn-ended' })]);
        expect(r.byAgent.a).toMatchObject({ engine: 'pty', costUsd: 0, turns: 1 });
    });

    it('takes the engine from the agent’s own events, so a switch is visible', () => {
        // An agent moved from pty to ACP mid-day: the LAST event wins, because that is what
        // it is running under now and what the next turn would use.
        const r = rollUpUsage([
            ev({ agentId: 'a', engine: 'pty', at: 1 }),
            ev({ agentId: 'a', engine: 'acp', at: 2 }),
        ]);
        expect(r.byAgent.a!.engine).toBe('acp');
    });
});
