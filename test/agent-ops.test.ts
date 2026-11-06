import { describe, expect, it } from 'vitest';
import { budgetDecision, deletePlan, restartPlan, switchDriverDecision, switchOutcome } from '../src/core/agent-ops.js';

/**
 * AGENT OPERATIONS (§6.2) — the pure half of the operations that were still missing.
 *
 * - RESTART (genie#1238) is ONE action that works from every state: it resumes the same thread,
 *   starts an agent that has none yet, and reaches a Broken one too. RESTART FRESH discards the
 *   conversation on purpose.
 * - DELETE is two named outcomes: UNMOUNT from Genie (every `.agents/*` file kept) vs DELETE for
 *   real; cross-system removal is an explicit opt-in inside the same prompt.
 * - SWITCH DRIVER carries identity, inbox, history and prompt across; REFUSED when the agent's
 *   AGENT.md lists `tuis:` and the requested one is not among them — the same rule for human and
 *   agent, shared code.
 * - A daily BUDGET parks the NEXT turn and asks; it never kills mid-turn; and it reports
 *   `unenforceable` rather than silently never firing when the provider reports no cost.
 */

describe('restart — Restart (the one action) and Restart fresh', () => {
    it('Restart resumes a resumable thread; an agent with no conversation yet STARTS its first (nothing to forget); a thread id Genie will not hand over is refused', () => {
        expect(restartPlan('graceful', { threadId: 'sess-ABC.123:7' })).toEqual({ ok: true, kind: 'graceful', resume: 'sess-ABC.123:7' });
        // genie#1238: a never-started agent's Restart (or Start) starts it. It used to be refused "no conversation to resume".
        expect(restartPlan('graceful', { threadId: null })).toEqual({ ok: true, kind: 'graceful', resume: null });
        expect(restartPlan('graceful', { threadId: 'a&echo PWNED' })).toEqual({ ok: false, reason: 'the stored thread id is not one Genie will hand to the provider; use Restart fresh' });
    });

    it('fresh discards the conversation, always', () => {
        expect(restartPlan('fresh', { threadId: 'sess-1' })).toEqual({ ok: true, kind: 'fresh', resume: null, discards: 'sess-1' });
        expect(restartPlan('fresh', { threadId: null })).toEqual({ ok: true, kind: 'fresh', resume: null, discards: null });
    });
});

describe('delete — two named outcomes', () => {
    it('unmount keeps every .agents/* file and only forgets the record; delete removes the folder too; both say exactly what they touch', () => {
        const unmount = deletePlan({ outcome: 'unmount', agentName: 'atlas', personaDir: '.agents/atlas', linkedSystems: [] });
        expect(unmount).toEqual({ outcome: 'unmount', removes: ['the agent record in Genie', 'its inbox registration'], keeps: ['.agents/atlas/ (every file)', 'its thread history on the provider'], external: [] });
        const real = deletePlan({ outcome: 'delete', agentName: 'atlas', personaDir: '.agents/atlas', linkedSystems: [] });
        expect(real.removes).toEqual(['the agent record in Genie', 'its inbox registration', '.agents/atlas/ (every file)', 'its stored handoff']);
        expect(real.keeps).toEqual(['its thread history on the provider']);
    });

    it('cross-system removal happens only with the explicit opt-in INSIDE the same prompt — by default linked systems are listed, not touched', () => {
        const dflt = deletePlan({ outcome: 'delete', agentName: 'atlas', personaDir: '.agents/atlas', linkedSystems: ['tynn'] });
        expect(dflt.external).toEqual([{ system: 'tynn', action: 'kept', optIn: 'alsoRemoveFrom: ["tynn"]' }]);
        const opted = deletePlan({ outcome: 'delete', agentName: 'atlas', personaDir: '.agents/atlas', linkedSystems: ['tynn'], alsoRemoveFrom: ['tynn'] });
        expect(opted.external).toEqual([{ system: 'tynn', action: 'removed' }]);
        // Opting in to a system the agent is not linked to is refused, not ignored.
        expect(() => deletePlan({ outcome: 'unmount', agentName: 'atlas', personaDir: '.agents/atlas', linkedSystems: [], alsoRemoveFrom: ['github'] })).toThrow(/github/);
    });
});

describe('switch provider — the person can always switch (Tynn story #380)', () => {
    it('any provider: AGENT.md names none and nothing in it refuses a switch', () => {
        expect(switchDriverDecision('claude', 'codex')).toEqual({ ok: true, from: 'claude', to: 'codex' });
    });

    it('switching to the same provider is a no-op, not an error', () => {
        expect(switchDriverDecision('claude', 'claude')).toEqual({ ok: true, from: 'claude', to: 'claude', noop: true });
    });
});

describe('switch provider — what the view says afterwards (Tynn story #380)', () => {
    const switched = { ok: true as const, from: 'claude', to: 'codex' };

    it('the conversation comes with it, and switching back resumes the old provider’s own', () => {
        const text = switchOutcome('atlas', { ...switched, carried: { turns: 3, of: 3, plan: false }, left: 'sess-1', droppedModel: null });
        expect(text).toBe('atlas switched claude → codex. Its conversation comes with it (the last 3 turns). Switching back to claude resumes its claude conversation.');
        expect(text).not.toMatch(/new conversation/);
    });

    it('names a model it dropped and says the new provider runs its own default', () => {
        expect(switchOutcome('atlas', { ...switched, carried: null, left: null, droppedModel: 'opus' })).toMatch(/"opus" is a claude model; codex starts on its default model/);
    });

    it('a never-run agent had no conversation: nothing is said to come along, or to resume', () => {
        const text = switchOutcome('atlas', { ...switched, carried: null, left: null, droppedModel: null });
        expect(text).toBe('atlas switched claude → codex.');
    });

    it('a no-op and a refusal are said as they are', () => {
        expect(switchOutcome('atlas', { ok: true, from: 'claude', to: 'claude', noop: true })).toBe('atlas already runs on claude');
        expect(switchOutcome('atlas', { ok: false, reason: 'nope' })).toBe('nope');
    });
});

describe('daily budgets — park the next turn and ask; never kill mid-turn', () => {
    it('under budget → proceed; at or over → PARK the next turn and ask, with the numbers', () => {
        expect(budgetDecision({ dailyLimitUsd: 5, spentTodayUsd: 3.2, turnInFlight: false, costReported: true })).toEqual({ kind: 'proceed', remainingUsd: 1.8 });
        expect(budgetDecision({ dailyLimitUsd: 5, spentTodayUsd: 5, turnInFlight: false, costReported: true })).toEqual({ kind: 'park', reason: 'atlas has spent $5.00 of today’s $5.00 budget; the next turn is parked until you raise the budget or say go', spentUsd: 5, limitUsd: 5 });
    });

    it('a turn in flight is never killed: over budget mid-turn → `finish-then-park`', () => {
        expect(budgetDecision({ dailyLimitUsd: 5, spentTodayUsd: 6.1, turnInFlight: true, costReported: true })).toMatchObject({ kind: 'finish-then-park', spentUsd: 6.1 });
    });

    it('a provider that reports no cost makes the budget UNENFORCEABLE — said out loud, never silently never-firing', () => {
        expect(budgetDecision({ dailyLimitUsd: 5, spentTodayUsd: 0, turnInFlight: false, costReported: false })).toEqual({ kind: 'unenforceable', reason: 'this provider reports no cost, so a dollar budget cannot be enforced; the limit is shown but will not park anything' });
    });

    it('no budget set → proceed with no remaining figure (nothing to measure against)', () => {
        expect(budgetDecision({ dailyLimitUsd: null, spentTodayUsd: 9, turnInFlight: false, costReported: true })).toEqual({ kind: 'proceed', remainingUsd: null });
    });
});
