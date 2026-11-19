import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fullPlanView } from '../src/core/chat-plan.js';
import { chatContext, type ChatDetail } from '../src/core/chat-view.js';
import { targetOf, type AgentRow } from '../src/core/dashboard-view.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { PlanHoverList } from '../src/renderer/components/PlanHover.js';

/**
 * THE AGENT'S PLAN STAYS VISIBLE (Tynn #918; the owner, 2026-11-19, screenshot).
 *
 * 1. The chat header's plan vanished once the agent's turn ended with work still running: "Working · 2 in the background"
 *    replaced "Working · Plan n/m · <step>". Both are facts about the agent now, so the line says both.
 * 2. The Dashboard's plan column ("4/7 · <step>") shows the WHOLE plan on hover: every step, its status, the current one
 *    marked. The steps come from the host's snapshot (`LiveSession.planSteps`), the same on every client.
 */
const steps = [
    { content: 'Read the brief', status: 'completed' },
    { content: 'Write the failing test', status: 'completed' },
    { content: 'Build the popover', status: 'in_progress' },
    { content: 'Wire the header', status: 'pending' },
    { content: 'Ship it', status: 'pending' },
];
const plan = { step: 2, of: 5, doing: 'Build the popover' };

describe('the chat header keeps the plan beside the working state', () => {
    const base = { agent: { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const }, rows: [] };
    const at = (extra: Partial<LiveSession>): ChatDetail => ({ ...base, session: { running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, plan: null, ...extra } as LiveSession });

    it('a turn that ended with work in the background still shows the plan, its progress and step, and lists it on hover', () => {
        const ctx = chatContext(at({ background: 2, plan, planSteps: steps }));
        expect(ctx.text).toBe('Working · 2 in the background · Plan 2/5 · Build the popover');
        expect(ctx.tone).toBe('ok');
        expect(ctx.planView?.items.map((i) => i.content)).toEqual(['Build the popover', 'Wire the header', 'Ship it']);
    });

    it('CONTROL: with no plan, the background line is what it was', () => {
        expect(chatContext(at({ background: 2 }))).toEqual({ text: 'Working · 2 in the background', tone: 'ok' });
    });

    it('CONTROL: a working turn still reads Working · Plan n/m · <step>', () => {
        expect(chatContext(at({ turnState: 'working', plan, planSteps: steps })).text).toBe('Working · Plan 2/5 · Build the popover');
    });
});

describe('fullPlanView: every step, for the Dashboard hover', () => {
    it('keeps every step in order with its status, the in-progress one current', () => {
        const view = fullPlanView(steps)!;
        expect(view.items.map((i) => [i.content, i.status, i.current])).toEqual([
            ['Read the brief', 'completed', false],
            ['Write the failing test', 'completed', false],
            ['Build the popover', 'in_progress', true],
            ['Wire the header', 'pending', false],
            ['Ship it', 'pending', false],
        ]);
        expect(view.done).toBe(2);
        expect(view.of).toBe(5);
    });

    it('is nothing without steps (positive control above)', () => {
        expect(fullPlanView(null)).toBeNull();
        expect(fullPlanView([])).toBeNull();
    });
});

describe('the Dashboard row carries the full plan from the host snapshot', () => {
    const record = { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn' } as Parameters<typeof agentRowFor>[0];
    const live = (extra: Partial<LiveSession>) => ({ running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, plan: null, ...extra }) as LiveSession;

    it('agentRowFor keeps the snapshot’s steps, and targetOf hands them to the plan cell', () => {
        const row = agentRowFor(record, live({ plan, planSteps: steps }), () => 2);
        expect(row.planSteps).toEqual(steps);
        const cell = targetOf(row);
        expect(cell?.kind).toBe('target');
        expect(cell?.kind === 'target' && cell.plan?.items.length).toBe(5);
    });

    it('CONTROL: no steps reported, no list to hover', () => {
        const row = agentRowFor(record, live({ plan }), () => 2);
        const cell = targetOf(row);
        expect(cell?.kind === 'target' && cell.plan).toBeNull();
    });
});

describe('the hover list', () => {
    it('lists every step with its status and marks the current one', () => {
        const html = renderToStaticMarkup(<PlanHoverList plan={fullPlanView(steps)!} />);
        expect(html.match(/data-plan-item="completed"/g)?.length).toBe(2);
        expect(html.match(/data-plan-item="in_progress"/g)?.length).toBe(1);
        expect(html.match(/data-plan-item="pending"/g)?.length).toBe(2);
        expect(html.match(/data-current="true"/g)?.length).toBe(1);
        expect(html).toMatch(/data-current="true"[^>]*>(?:(?!<\/li>).)*Build the popover/s);
        for (const s of steps) expect(html).toContain(s.content);
    });

    it('the Dashboard plan cell opens it on hover; a row with no steps has nothing to open (control in the same render)', () => {
        const row = (over: Partial<AgentRow>): AgentRow => ({
            id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: '12m',
            ask: null, reason: null, fixes: [], step: '2/5', target: 'Build the popover', activity: null, delivery: null,
            collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
        });
        const html = renderToStaticMarkup(
            <Dashboard rows={[row({ planSteps: steps }), row({ id: 'a2', name: 'bolt' })]} workspaces={[{ id: 'tynn', path: 'C:/_Projects/tynn.ai' }]} onOpenAgent={() => {}} onAddAgent={() => {}} />,
        );
        expect(html.match(/data-plan-hover=""/g)?.length).toBe(1);
        // Both rows still show their step and target: the hover adds, it never replaces.
        expect(html.match(/Build the popover/g)?.length).toBe(2);
    });
});
