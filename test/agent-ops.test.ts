import { describe, expect, it } from 'vitest';
import { budgetDecision, deletePlan, restartPlan, switchDriverDecision, switchOutcome, type AgentManifest } from '../src/core/agent-ops.js';

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

describe('switch driver — the same rule for human and agent', () => {
    const manifest = (tuis?: string[]): AgentManifest => ({ name: 'atlas', ...(tuis ? { tuis } : {}) });

    it('carries identity, inbox, history and prompt; with no `tuis:` list any provider is allowed', () => {
        expect(switchDriverDecision(manifest(), 'claude', 'codex', 'user')).toEqual({ ok: true, carries: ['identity', 'inbox', 'history', 'prompt'], from: 'claude', to: 'codex' });
    });

    it('with a `tuis:` list, a provider not on it is REFUSED — for the user and for an agent alike, with the list named', () => {
        const refusal = { ok: false, reason: 'atlas’s AGENT.md allows tuis: claude, kimi; codex is not among them' };
        expect(switchDriverDecision(manifest(['claude', 'kimi']), 'claude', 'codex', 'user')).toEqual(refusal);
        expect(switchDriverDecision(manifest(['claude', 'kimi']), 'claude', 'codex', 'agent')).toEqual(refusal);
        expect(switchDriverDecision(manifest(['claude', 'kimi']), 'claude', 'kimi', 'agent')).toMatchObject({ ok: true, to: 'kimi' });
    });

    it('switching to the same driver is a no-op, not an error', () => {
        expect(switchDriverDecision(manifest(), 'claude', 'claude', 'user')).toEqual({ ok: true, carries: [], from: 'claude', to: 'claude', noop: true });
    });
});

describe('switch driver — what the view says afterwards', () => {
    const switched = { ok: true as const, carries: ['identity', 'inbox', 'history', 'prompt'], from: 'claude', to: 'codex' };

    it('says the conversation starts FRESH on the new provider — the old provider’s conversation does not come along', () => {
        const text = switchOutcome('atlas', { ...switched, discarded: 'sess-1', droppedModel: null });
        expect(text).toMatch(/^atlas switched claude → codex/);
        expect(text).toMatch(/starts a new conversation on codex/);
        expect(text).toMatch(/claude conversation stays with claude/);
        expect(text).toMatch(/kept: identity, inbox, history, prompt/);
        expect(text).not.toMatch(/model/);
    });

    it('names a model it dropped and says the new provider runs its own default', () => {
        expect(switchOutcome('atlas', { ...switched, discarded: null, droppedModel: 'opus' })).toMatch(/"opus" is a claude model; codex starts on its default model/);
    });

    it('a never-run agent had no conversation, so none is said to be left behind', () => {
        const text = switchOutcome('atlas', { ...switched, discarded: null, droppedModel: null });
        expect(text).toMatch(/starts a new conversation on codex/);
        expect(text).not.toMatch(/stays with claude/);
    });

    it('a no-op and a refusal are said as they are', () => {
        expect(switchOutcome('atlas', { ok: true, carries: [], from: 'claude', to: 'claude', noop: true })).toBe('atlas already runs on claude');
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
