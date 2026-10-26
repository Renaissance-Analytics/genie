import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowRecord } from '../src/main/flow-store.js';
import { FlowRow, FlowsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from '../src/renderer/features.js';

/**
 * THE FLOWS PAGE IS A LIST OF WORKFLOWS (genie#1204; the owner, 2026-10-26: "Flows are not bg process, they are fucking
 * fancy-flow workflows like genie 1 had"). Each row says what the flow IS — its trigger and its steps, in order — and opens
 * it on the canvas; Add a flow opens a new canvas. The form is gone.
 */

const n = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const flow = (over: Partial<FlowRecord> = {}): FlowRecord => ({
    id: 'flow_a', workspaceId: 'tynn', name: 'queue watcher', armed: false,
    document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [
        n('t', 'schedule_trigger', { cron: '*/30 * * * *' }),
        n('c', 'genie/terminal_run', { workspace: 'tynn', command: 'scripts/check-queue.sh', allowFailure: true }, 200),
        n('b', 'branch', { conditions: [{ left: '{{in.exitCode}}', operator: 'eq', right: '10' }] }, 400),
        n('a', 'genie/agent_prompt', { agent: 'atlas@tynn', prompt: 'the queue is stuck' }, 600),
    ], edges: [{ id: 'e1', source: 't', target: 'c' }, { id: 'e2', source: 'c', target: 'b' }, { id: 'e3', source: 'b', target: 'a', sourceHandle: 'true' }] } },
    createdBy: { kind: 'user' }, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', refusals: [], runs: [],
    ...over,
});
const data = (flows: FlowRecord[]): FeatureData => ({ ...EMPTY_FEATURES, flows: { flows, adding: null } });
const workspaces = [{ id: 'tynn', path: '/w/tynn' }];

const click = (node: unknown, match: (props: Record<string, unknown>) => boolean): void => {
    const walk = (x: unknown): void => {
        if (x === null || typeof x !== 'object') return;
        if (Array.isArray(x)) { x.forEach(walk); return; }
        const el = x as { type?: unknown; props?: Record<string, unknown> };
        if (el.type === 'button' && el.props && match(el.props) && typeof el.props.onClick === 'function') (el.props.onClick as () => void)();
        walk(el.props?.children);
    };
    walk(node);
};

describe('a flow row', () => {
    it('says what the flow is: its trigger and each step, in graph order', () => {
        const html = renderToStaticMarkup(<FlowsSurface data={data([flow()])} workspaces={workspaces} onAction={() => {}} onNavigate={() => {}} />);
        const summary = /data-flow-summary="flow_a"[^>]*>(.*?)<\/span>/s.exec(html)![1]!;
        expect(summary).toContain('On a schedule (*/30 * * * *)');
        expect(summary.indexOf('runs the command')).toBeLessThan(summary.indexOf('Branch'));
        expect(summary.indexOf('Branch')).toBeLessThan(summary.indexOf('prompts atlas@tynn'));
        expect(html).toContain('3 steps');
    });

    it('opens on the canvas from its name and from Open; the form is gone', () => {
        const sent: FeatureAction[] = [];
        const props = { flow: flow(), workspaces, now: 0, confirming: null, onAction: (a: FeatureAction) => { sent.push(a); }, onAsk: () => {} };
        click(FlowRow(props), (p) => p['data-flow-open'] === 'flow_a');
        click(FlowRow(props), (p) => p.children === 'Open');
        expect(sent).toEqual([{ kind: 'flows.openEditor', flowId: 'flow_a' }, { kind: 'flows.openEditor', flowId: 'flow_a' }]);
        const html = renderToStaticMarkup(<FlowsSurface data={data([flow()])} workspaces={workspaces} onAction={() => {}} onNavigate={() => {}} />);
        expect(html).not.toContain('data-form="add-flow"');
        expect(html).not.toMatch(/>Edit</);
    });

    it('Add a flow opens a new canvas in the chosen workspace; with no flows, the page says so and offers the canvas', () => {
        const html = renderToStaticMarkup(<FlowsSurface data={data([])} workspaces={workspaces} onAction={() => {}} onNavigate={() => {}} />);
        expect(html).toMatch(/No flows yet/);
        expect(html).toContain('data-flow-new-empty');
    });
});
