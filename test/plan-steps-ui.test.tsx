import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE PLAN PANEL ON SCREEN (the board): `3/7` as before, then the steps — ✓ done, ◐ in progress (bold), ○ pending —
 * one per entry of the agent's latest plan. Without a readable plan event the panel keeps its `step/of` line alone.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }),
    t('a1:1', { kind: 'plan', entries: [
        { content: 'Read the brief', status: 'completed' },
        { content: 'Write the migration', status: 'in_progress' },
        { content: 'Run the suite', status: 'pending' },
    ] }),
];
const session: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: { step: 1, of: 3, doing: 'Write the migration' } } as LiveSession;
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={session} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

describe('the plan panel', () => {
    it('lists the steps with their marks, the current one bold, under the step/of line', () => {
        const html = render();
        expect(html).toMatch(/data-rail="plan"[\s\S]*?1\/3/);
        expect(html).toMatch(/data-plan-step="completed"[^>]*><span[^>]*>✓/);
        expect(html).toMatch(/data-plan-step="in_progress"[^>]*data-current="true"[^>]*><span[^>]*>◐/);
        expect(html).toMatch(/data-plan-step="pending"[^>]*><span[^>]*>○/);
        expect(html).toContain('Write the migration');
        expect((html.match(/data-plan-step=/g) ?? []).length).toBe(3);
    });

    it('without a readable plan event the panel keeps its step/of line and lists nothing', () => {
        const html = render({ rows: [rows[0]!] });
        expect(html).toContain('data-rail="plan"');
        expect(html).not.toContain('data-plan-step=');
    });
});
