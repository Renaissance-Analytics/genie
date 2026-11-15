import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chatPlanView } from '../src/core/chat-plan.js';
import { chatContext, type ChatDetail } from '../src/core/chat-view.js';
import { ChatPlanList, ChatPlanLine } from '../src/renderer/components/ChatPlanLine.js';
import type { LiveSession } from '../src/core/roster.js';

/**
 * THE CHAT'S "Working · Plan n/m" LINE (Tynn #703): hovering it lists every OPEN item of the agent's active plan, in
 * order, with its status, the current one marked; done items are collapsed into a count, never listed.
 */
const steps = [
    { content: 'Read the brief', status: 'completed' },
    { content: 'Write the failing test', status: 'completed' },
    { content: 'Build the popover', status: 'in_progress' },
    { content: 'Wire the header', status: 'pending' },
    { content: 'Ship it', status: 'pending' },
];

describe('chatPlanView: the open items of a plan', () => {
    it('lists the open items in order, marks the current one, and counts the done ones', () => {
        const view = chatPlanView(steps)!;
        expect(view.items.map((i) => i.content)).toEqual(['Build the popover', 'Wire the header', 'Ship it']);
        expect(view.items.map((i) => i.current)).toEqual([true, false, false]);
        expect(view.done).toBe(2);
        expect(view.of).toBe(5);
    });

    it('is nothing without a plan, and nothing when every item is done (positive control above)', () => {
        expect(chatPlanView(null)).toBeNull();
        expect(chatPlanView([])).toBeNull();
        expect(chatPlanView([{ content: 'a', status: 'completed' }])).toBeNull();
    });
});

describe('chatContext carries the plan view while the agent works', () => {
    const base = { agent: { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const }, rows: [] };
    const working = (extra: Partial<LiveSession>): ChatDetail => ({ ...base, session: { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, plan: { step: 3, of: 5, doing: 'Build the popover' }, ...extra } as LiveSession });

    it('uses the kept steps of the session', () => {
        const ctx = chatContext(working({ planSteps: steps }));
        expect(ctx.text).toBe('Working · Plan 3/5 · Build the popover');
        expect(ctx.planView?.items).toHaveLength(3);
    });

    it('has none when the session reports no plan', () => {
        expect(chatContext(working({ plan: null })).planView).toBeUndefined();
    });
});

describe('the popover content', () => {
    const view = chatPlanView(steps)!;
    const html = renderToStaticMarkup(<ChatPlanList plan={view} />);

    it('one row per open item, in order, each with its status; the current one is marked', () => {
        const rows = [...html.matchAll(/data-plan-item="([a-z_]+)"/g)].map((m) => m[1]);
        expect(rows).toEqual(['in_progress', 'pending', 'pending']);
        expect(html).toContain('data-current="true"');
        expect(html.indexOf('Build the popover')).toBeLessThan(html.indexOf('Wire the header'));
        expect(html.indexOf('Wire the header')).toBeLessThan(html.indexOf('Ship it'));
    });

    it('done items are collapsed to a count, not listed', () => {
        expect(html).not.toContain('Read the brief');
        expect(html).toContain('2 done');
    });
});

describe('the line opens the popover on hover', () => {
    it('the line is the trigger, and still reads as before', () => {
        const html = renderToStaticMarkup(<ChatPlanLine text="Working · Plan 3/5 · Build the popover" plan={chatPlanView(steps)!} />);
        expect(html).toContain('data-plan-line=""');
        expect(html).toContain('Working · Plan 3/5 · Build the popover');
    });

    it('with no plan view the line is plain text and opens nothing', () => {
        const html = renderToStaticMarkup(<ChatPlanLine text="Working" plan={undefined} />);
        expect(html).not.toContain('data-plan-line');
        expect(html).toContain('Working');
    });
});
