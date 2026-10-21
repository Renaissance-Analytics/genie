import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { PLAN_COLLAPSED_KEY, readPlanOpen, writePlanOpen } from '../src/core/plan-column.js';
import { addTab } from '../src/core/workspace-tabs.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';

/**
 * THE ACTIVE PLAN COLUMN COLLAPSES (beta.33 item 11). The owner (FTQ q_99659edf note, 2026-10-20): "the plan column is
 * already a column that appears on the side of the agent ux (just left of the chat), and it needs to be able to collapse
 * with a button in the top right of the workspace tab row that opens and hides it." One toggle at the strip's right end,
 * on an agent's page; the choice is remembered on this device (as the rail's collapse is, Tynn #799).
 */
const memory = (initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } => {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};

describe('the choice, remembered', () => {
    it('open until you hide it; hidden stays hidden; shown again stays shown', () => {
        const store = memory();
        expect(readPlanOpen(store)).toBe(true);
        writePlanOpen(store, false);
        expect(store.data.get(PLAN_COLLAPSED_KEY)).toBe('1');
        expect(readPlanOpen(store)).toBe(false);
        writePlanOpen(store, true);
        expect(readPlanOpen(store)).toBe(true);
    });

    it('no storage (or one that throws): open — a preference that cannot be read never hides the plan', () => {
        expect(readPlanOpen(null)).toBe(true);
        const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
        expect(readPlanOpen(broken)).toBe(true);
        expect(() => writePlanOpen(broken, false)).not.toThrow();
    });
});

describe('the toggle in the workspace tab row', () => {
    const agents = [{ id: 'a1', name: 'atlas', state: 'working' }];
    const strip = (planToggle?: { open: boolean; onToggle: () => void }) => renderToStaticMarkup(
        <WorkspaceTabs designed={addTab({ tabs: [] }, 'Ops').state} agents={agents} current={{ kind: 'agent', id: 'a1' }} canDesign hasSettings onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} {...(planToggle ? { planToggle } : {})} />,
    );

    it('sits at the strip’s RIGHT END — after Settings — and says whether the plan is shown', () => {
        const html = strip({ open: true, onToggle: () => {} });
        expect((html.match(/data-action="toggle-plan-column"/g) ?? []).length).toBe(1);
        expect(html.indexOf('data-action="toggle-plan-column"')).toBeGreaterThan(html.indexOf('data-workspace-tab="settings"'));
        expect(html).toMatch(/data-action="toggle-plan-column"[^>]*aria-pressed="true"/);
        expect(html).toMatch(/data-action="toggle-plan-column"[^>]*aria-label="Hide the active plan"/);
        const hidden = strip({ open: false, onToggle: () => {} });
        expect(hidden).toMatch(/data-action="toggle-plan-column"[^>]*aria-pressed="false"/);
        expect(hidden).toMatch(/data-action="toggle-plan-column"[^>]*aria-label="Show the active plan"/);
    });

    it('CONTROL: not offered where there is no plan column (a workspace view, or an agent seen only through its terminal)', () => {
        expect(strip()).not.toContain('toggle-plan-column');
    });
});

describe('the column follows the choice', () => {
    const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
    const session = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: { step: 1, of: 3, doing: 'Write the migration' } } as LiveSession;
    const view = (planOpen?: boolean) => renderToStaticMarkup(
        <AgentView agent={agent} session={session} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...(planOpen === undefined ? {} : { planOpen })} />,
    );

    it('hidden: no column; shown (and by default): the column', () => {
        expect(view(false)).not.toContain('data-plan-column=');
        expect(view(true)).toContain('data-plan-column=');
        expect(view()).toContain('data-plan-column=');
    });
});
