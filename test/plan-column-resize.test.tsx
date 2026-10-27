import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import * as planColumn from '../src/core/plan-column.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE PLAN COLUMN IS RESIZABLE (genie#1280; the owner, 2026-10-27: "Let users resize the plan column too. This gets
 * crowded and hard to read."). Its left edge drags like the chat's (Tynn #798, core/chat-width.ts), the width is kept on
 * this device, and it has a floor and a ceiling. Dragged well past the floor it collapses, the same as its toggle.
 *
 * Genie 1 (v0.7.0-beta.342 `renderer/components/Master/TerminalGrid.tsx:111,436-470,694-695`): every split dragged,
 * clamped at MIN_PANEL_PX, persisted, and a double-click on the gutter reset it. The same here.
 *
 * No DOM (docs/decisions.md D3): the arithmetic is asserted on the pure functions, and the markup on a static render.
 */
const pc = planColumn as Record<string, unknown>;
const fn = <T,>(name: string): T => {
    expect(typeof pc[name], `core/plan-column.ts exports ${name}`).toBe('function');
    return pc[name] as T;
};
const num = (name: string): number => {
    expect(typeof pc[name], `core/plan-column.ts exports ${name}`).toBe('number');
    return pc[name] as number;
};
const memory = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
};

describe('the width: clamped and remembered', () => {
    it('a floor, a ceiling, and the designed width between them', () => {
        const min = num('PLAN_WIDTH_MIN');
        const max = num('PLAN_WIDTH_MAX');
        const def = num('PLAN_WIDTH_DEFAULT');
        expect(min).toBeLessThan(def);
        expect(def).toBeLessThan(max);
        const clamp = fn<(w: number) => number>('clampPlanWidth');
        expect(clamp(10)).toBe(min);
        expect(clamp(10_000)).toBe(max);
        expect(clamp(min + 33.4)).toBe(min + 33);
    });

    it('written on one write and read back; nothing kept = the designed width; garbage = the designed width; out of range = clamped', () => {
        const read = fn<(s: unknown) => number>('readPlanWidth');
        const write = fn<(s: unknown, w: number) => void>('writePlanWidth');
        const key = pc.PLAN_WIDTH_KEY as string;
        expect(typeof key).toBe('string');
        const store = memory();
        expect(read(store)).toBe(num('PLAN_WIDTH_DEFAULT'));
        write(store, 412);
        expect(store.data.get(key)).toBe('412');
        expect(read(store)).toBe(412);
        expect(read(memory({ [key]: 'wide' }))).toBe(num('PLAN_WIDTH_DEFAULT'));
        expect(read(memory({ [key]: '99999' }))).toBe(num('PLAN_WIDTH_MAX'));
        expect(read(null)).toBe(num('PLAN_WIDTH_DEFAULT'));
        const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
        expect(read(broken)).toBe(num('PLAN_WIDTH_DEFAULT'));
        expect(() => write(broken, 300)).not.toThrow();
    });

    it('a drag of the LEFT edge: leftward widens, rightward narrows to the floor, and well past the floor collapses', () => {
        const drag = fn<(from: number, dx: number) => number | 'collapse'>('planDragWidth');
        const min = num('PLAN_WIDTH_MIN');
        expect(drag(260, -100)).toBe(360);
        expect(drag(min + 60, +40)).toBe(min + 20);
        expect(drag(260, 260 - min + 20)).toBe(min);
        expect(drag(260, 400)).toBe('collapse');
        expect(drag(260, -10_000)).toBe(num('PLAN_WIDTH_MAX'));
    });
});

const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }),
    t('a1:1', { kind: 'plan', entries: [{ content: 'Read the brief', status: 'completed' }, { content: 'Write the migration', status: 'in_progress' }] }),
];
const session = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: { step: 1, of: 2, doing: 'Write the migration' } } as unknown as LiveSession;
const view = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={session} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);
const columnTag = (html: string) => html.match(/<aside[^>]*data-plan-column=""[^>]*>/)?.[0] ?? '';

describe('the column in the Agent view', () => {
    it('drawn at the remembered width, with a separator on its left edge to drag or arrow', () => {
        const key = pc.PLAN_WIDTH_KEY as string;
        const html = view({ planStorage: memory({ [key]: '420' }) });
        expect(columnTag(html)).toContain('width:420px');
        const handle = html.match(/<div[^>]*data-plan-resize=""[^>]*>/)?.[0] ?? '';
        expect(handle).toContain('role="separator"');
        expect(handle).toContain('aria-orientation="vertical"');
        expect(handle).toContain('aria-label="Resize plan"');
        expect(handle).toContain('tabindex="0"');
        expect(handle).toContain(`aria-valuemin="${num('PLAN_WIDTH_MIN')}"`);
        expect(handle).toContain(`aria-valuemax="${num('PLAN_WIDTH_MAX')}"`);
        expect(handle).toContain('aria-valuenow="420"');
        expect(handle).toContain('cursor-col-resize');
    });

    it('nothing remembered = the designed width (the old fixed w-[260px] is gone)', () => {
        const html = view({ planStorage: memory() });
        expect(columnTag(html)).toContain(`width:${num('PLAN_WIDTH_DEFAULT')}px`);
        expect(columnTag(html)).not.toContain('w-[260px]');
    });

    it('CONTROL: hidden, there is no column and no separator', () => {
        const html = view({ planOpen: false, planStorage: memory() });
        expect(html).not.toContain('data-plan-column=');
        expect(html).not.toContain('data-plan-resize=');
    });
});
