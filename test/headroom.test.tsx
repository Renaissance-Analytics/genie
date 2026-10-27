import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { headroomLine, headroomOf } from '../src/core/headroom.js';
import { toStreamEvent, type StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE HEADROOM ROW (the board's rail: `Claude Max · 38% of 5h window · resets 4:00 PM`; the dashboard design's
 * `5-hour · 38% left`). prism-acp attaches the provider's rate-limit detail to a `notice` under
 * `_meta["particle.academy/rate_limit"]` — Claude as `windows` keyed `five_hour` / `seven_day` with `utilization`
 * (a fraction, which can pass 1 in overage) and the binding `rateLimitType`; codex as `primary` / `secondary` with
 * `usedPercent` and `windowDurationMins`, plus `planType`. Genie dropped it. The row is the binding window's share
 * LEFT and when it resets, from the latest reading; with no reading there is no row.
 */
const KEY = 'particle.academy/rate_limit';
const notice = (limit: unknown) => ({ sessionUpdate: 'notice', notice: { level: 'info', message: 'rate limit' }, _meta: { [KEY]: limit } });
const at = (h: number, m: number) => new Date(2026, 9, 12, h, m).getTime();
const claude = { status: 'allowed', resetsAtMs: at(16, 0), rateLimitType: 'five_hour', windows: { five_hour: { utilization: 0.62, resetsAtMs: at(16, 0) }, seven_day: { utilization: 0.2, resetsAtMs: at(9, 0) } }, raw: {} };
const codex = { ordinaryUsageAllowed: true, planType: 'pro', primary: { usedPercent: 40, windowDurationMins: 300, resetsAtMs: at(18, 30) }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAtMs: at(9, 0) } };

describe('the wire', () => {
    it('reads Claude\'s binding window and codex\'s primary one; a notice without the detail has none (positive control)', () => {
        expect(toStreamEvent(notice(claude))).toMatchObject({ kind: 'notice', headroom: { plan: null, window: '5h', leftPct: 38, resetsAtMs: at(16, 0), over: false } });
        expect(toStreamEvent(notice(codex))).toMatchObject({ kind: 'notice', headroom: { plan: 'pro', window: '5h', leftPct: 60, resetsAtMs: at(18, 30), over: false } });
        expect(toStreamEvent({ sessionUpdate: 'notice', notice: { level: 'info', message: 'hi' } })).toMatchObject({ kind: 'notice', headroom: null });
    });

    it('overage is said, never clamped into a number the provider did not send', () => {
        const over = { ...claude, windows: { five_hour: { utilization: 1.08, resetsAtMs: at(16, 0) } } };
        expect(toStreamEvent(notice(over))).toMatchObject({ headroom: { leftPct: 0, over: true } });
    });
});

describe('the row', () => {
    const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1 });
    const read = (limit: unknown) => toStreamEvent(notice(limit))!;

    it('from the LATEST reading; none, no row', () => {
        const rows = [t('a', read(codex)), t('b', { kind: 'message', speaker: 'agent', peerName: null, text: 'x' }), t('c', read(claude))];
        expect(headroomOf(rows)).toMatchObject({ window: '5h', leftPct: 38 });
        expect(headroomOf([rows[1]!])).toBeNull();
    });

    it('reads the board\'s line, the plan first when the provider named it', () => {
        expect(headroomLine(headroomOf([t('c', read(claude))])!)).toBe('38% of 5h window left · resets 4:00 PM');
        expect(headroomLine(headroomOf([t('a', read(codex))])!)).toBe('pro · 60% of 5h window left · resets 6:30 PM');
        expect(headroomLine({ plan: null, window: '5h', leftPct: 0, resetsAtMs: at(16, 0), over: true, windows: [{ window: '5h', usedPct: 108, leftPct: 0, resetsAtMs: at(16, 0), over: true }] })).toBe('over the 5h window · resets 4:00 PM');
    });
});

describe('the rail', () => {
    const agent = { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared' as const, cwd: 'repos/genie2' };
    const session = { running: true, turnState: 'idle' as const, startedAt: null, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model: null };
    const render = (rows: readonly TimedEvent[]) => renderToStaticMarkup(
        <AgentView agent={agent} session={session} rows={rows} tab="settings" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => at(12, 0)} />,
    );

    it('shows the headroom before the first turn, under Budget; with no reading there is no row (positive control)', () => {
        const html = render([{ id: 'n', event: toStreamEvent(notice(claude))!, at: 1 }]);
        expect(html).toMatch(/data-rail="budget"[\s\S]*data-rail-headroom[^>]*title="Resets [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4} at 4:00 PM"[^>]*>38% of 5h window left · resets 4:00 PM</);
        expect(render([])).not.toContain('data-rail-headroom');
    });
});
