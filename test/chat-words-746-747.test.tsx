import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { budgetDecision } from '../src/core/agent-ops.js';
import { costWords } from '../src/core/cost-words.js';
import type { Headroom } from '../src/core/headroom.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { LedgerRowCache, ledgerRow, type TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { Stream } from '../src/renderer/components/Stream.js';

/**
 * WORDS IN THE CHAT THAT READ AS SOMETHING WRONG (client onboarding call, 2026-11-16).
 *
 * Tynn #746: a thought the provider sent no text for read "Reasoning not sent by the provider". The client read it out
 * as a fault. It is an ordinary thought with nothing to show, so it says Thinking.
 *
 * Tynn #747: "$3.25" alarmed a client on a Claude subscription, who read it as a charge. The figure is what the tokens
 * cost at API prices. When the agent's ledger holds a plan's limit reading (5 h / weekly windows, which only a
 * subscription plan reports), the figure says it is the API-price equivalent and is in the plan. Otherwise it still
 * says "at API prices" (true for an API key, which is billed at those prices) and claims nothing about a plan.
 * Every cost readout follows it: the usage row, the Agent view's rail, the budget's park reason.
 */
const at = 1_760_000_000_000;
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at });

const headroom: Headroom = { plan: null, window: '5h', leftPct: 70, resetsAtMs: at + 3_600_000, over: false, windows: [{ window: '5h', usedPct: 30, leftPct: 70, resetsAtMs: at + 3_600_000, over: false }] };
const limitNotice = t('rl', { kind: 'notice', level: 'info', message: 'Rate limit', headroom } as StreamEvent);
const usage = (id: string, cost: number | null, turnCost?: number): TimedEvent =>
    t(id, { kind: 'usage', used: 182_000, size: 200_000, cost, ...(turnCost === undefined ? {} : { turnCost }) } as StreamEvent);

const PLAN_TURN = '≈ $0.61 this turn at API prices · in your plan';
const PLAIN_TURN = '$0.61 this turn at API prices';

describe('#746: a thought with no text reads as a thought, never as a fault', () => {
    it('an empty thought says Thinking, and keeps its estimate', () => {
        const row = ledgerRow(t('k', { kind: 'think', text: '', tokens: null, estimate: 642 }));
        expect(row.main).toBe('Thinking');
        expect(row.meta).toBe('~642 tok');
        expect(row.expandable).toBe(false);
    });

    it('its words name no provider, no failure, nothing missing', () => {
        const row = ledgerRow(t('k', { kind: 'think', text: '   ', tokens: null }));
        expect(row.main).not.toMatch(/not sent|provider|error|fail|missing|redact/i);
        expect(row.main).toBe('Thinking');
    });

    it('CONTROL: a thought WITH text still shows its text and expands to it', () => {
        const row = ledgerRow(t('k', { kind: 'think', text: 'Read the failing test first.', tokens: null }));
        expect(row.main).toBe('Read the failing test first.');
        expect(row).toMatchObject({ expandable: true, full: 'Read the failing test first.' });
    });
});

describe('#747: costWords', () => {
    it('on a plan: the API-price equivalent, in the plan, and the hover says it is not a charge', () => {
        const w = costWords(0.61, 'this turn', true);
        expect(w.text).toBe(PLAN_TURN);
        expect(w.title).toMatch(/not a charge/);
    });

    it('no plan known: the figure at API prices, claiming no plan', () => {
        const w = costWords(0.61, 'this turn', false);
        expect(w.text).toBe(PLAIN_TURN);
        expect(w.text).not.toMatch(/≈|plan/);
        expect(w.title).toMatch(/API prices/);
    });
});

describe('#747: the usage row', () => {
    it('on a plan, the row says so, with the hover words', () => {
        const row = ledgerRow(usage('u', 4.12, 0.61), { onPlan: true });
        expect(row.main).toBe(`context 182k / 200k · ${PLAN_TURN}`);
        expect(row.title).toMatch(/not a charge/);
    });

    it('no plan known, the row gives the figure at API prices', () => {
        const row = ledgerRow(usage('u', 4.12, 0.61));
        expect(row.main).toBe(`context 182k / 200k · ${PLAIN_TURN}`);
    });

    it('CONTROL: a provider that reports no cost (codex) gets no figure and no price words', () => {
        const row = ledgerRow(usage('u', null), { onPlan: true });
        expect(row.main).toBe('context 182k / 200k');
        expect(row.main).not.toMatch(/\$|API prices/);
    });

    it('the row cache maps the row again when the plan becomes known', () => {
        const cache = new LedgerRowCache();
        const row = usage('u', 4.12, 0.61);
        expect(cache.row(row, {}).main).not.toContain('in your plan');
        expect(cache.row(row, { onPlan: true }).main).toContain('in your plan');
    });

    it('the Stream draws a plan agent’s usage row with its words and hover', () => {
        const html = renderToStaticMarkup(<Stream rows={[usage('u1', 1), usage('u2', 1.61)]} lanes={null} at={null} selectedId={null} onSelect={() => {}} onPlan />);
        expect(html).toContain('≈ $0.61 this turn at API prices · in your plan');
        expect(html).toMatch(/title="[^"]*not a charge/);
    });
});

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'working', startedAt: at - 14_000,
    pendingApproval: null, failure: null, contextUsed: 38_000, contextSize: 200_000,
    lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model: null,
    ...over,
});
const AGENT = { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared' as const, cwd: 'repos/app' };
const view = (rows: readonly TimedEvent[], tab: 'stream' | 'settings'): string => renderToStaticMarkup(
    <AgentView agent={AGENT} session={session()} rows={rows} tab={tab} lanes={null} at={null} selectedId={null} turns={11} cost={0.91} onNavigate={() => {}} onSelect={() => {}} now={() => at} />,
);

describe('#747: the Agent view', () => {
    it('the rail of an agent whose ledger holds a plan reading: the session figure at API prices, in the plan', () => {
        const html = view([limitNotice, usage('u1', 0.91)], 'settings');
        expect(html).toContain('≈ $0.91 this session at API prices · in your plan · 11 turns');
        expect(html).toMatch(/data-rail-cost[^>]*title="[^"]*not a charge|title="[^"]*not a charge[^"]*"[^>]*data-rail-cost/);
    });

    it('the rail with no plan reading: the session figure at API prices', () => {
        const html = view([usage('u1', 0.91)], 'settings');
        expect(html).toContain('$0.91 this session at API prices · 11 turns');
        expect(html).not.toContain('in your plan');
    });

    it('the Stream tab of a plan agent draws the turn figure as in the plan (the view passes what it knows)', () => {
        const html = view([limitNotice, usage('u1', 1), usage('u2', 1.61)], 'stream');
        expect(html).toContain('≈ $0.61 this turn at API prices · in your plan');
    });
});

describe('#747: the budget', () => {
    it('a parked turn names the figure as API prices, not as money spent', () => {
        const d = budgetDecision({ dailyLimitUsd: 5, spentTodayUsd: 5, turnInFlight: false, costReported: true });
        expect(d).toMatchObject({ kind: 'park', reason: 'atlas has used $5.00 at API prices of today’s $5.00 budget; the next turn is parked until you raise the budget or say go' });
    });
});
