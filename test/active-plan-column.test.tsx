import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE ACTIVE PLAN COLUMN (the owner, 2026-10-19: "Genie needs to include an Active Plan column in the agent view to the
 * left of the chat"). The plan was a section of the agent view's shared right rail, drawn only once a plan existed and
 * sharing its space with the inspector. Now it is a column of its own, the agent view's LAST — so it sits directly left
 * of the docked chat — always there for an agent that reports plans: the progress, the steps with the current one
 * marked, and before any plan a sentence saying there is none yet. An agent seen only through its terminal reports no
 * plan, so it has no column.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const planRows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }),
    t('a1:1', { kind: 'plan', entries: [
        { content: 'Read the brief', status: 'completed' },
        { content: 'Write the migration', status: 'in_progress' },
        { content: 'Run the suite', status: 'pending' },
    ] }),
];
const base = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null } as const;
const withPlan = { ...base, plan: { step: 1, of: 3, doing: 'Write the migration' } } as LiveSession;
const noPlan = { ...base, plan: null } as LiveSession;
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={withPlan} rows={planRows} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

describe('the Active Plan column', () => {
    it('is a column of its own — ONE, not inside the shared rail — with the progress and the steps, the current one marked', () => {
        const html = render();
        expect((html.match(/data-plan-column=/g) ?? []).length).toBe(1);
        const column = html.slice(html.indexOf('data-plan-column='));
        expect(column).toMatch(/Active plan/);
        expect(column).toMatch(/1\/3/);
        expect((column.match(/data-plan-step=/g) ?? []).length).toBe(3);
        expect(column).toMatch(/data-plan-step="in_progress"[^>]*data-current="true"/);
        // Not a section of the rail any more.
        expect(html).not.toContain('data-rail="plan"');
    });

    it('is the agent view’s LAST column — after the rail — so it sits directly left of the chat', () => {
        const html = render({ selectedId: 'a1:1' });
        const rail = html.indexOf('data-right-column=');
        const plan = html.indexOf('data-plan-column=');
        expect(plan).toBeGreaterThan(-1);
        expect(rail === -1 || plan > rail).toBe(true);
    });

    it('before any plan: still there, and says there is none yet — never an empty bordered box', () => {
        const html = render({ session: noPlan, rows: [planRows[0]!] });
        expect(html).toContain('data-plan-column=');
        expect(html).toMatch(/data-plan-column=[\s\S]*?sable has not reported a plan yet/);
        expect(html).not.toMatch(/data-plan-column=[\s\S]*?data-plan-step=/);
    });

    it('CONTROL: an agent seen only through its terminal reports no plan — no column', () => {
        const html = render({ agent: { ...agent, fidelity: 'observed' as const }, session: noPlan, rows: [] });
        expect(html).not.toContain('data-plan-column=');
    });
});
