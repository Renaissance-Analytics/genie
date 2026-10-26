import { NodePalette } from '@particle-academy/fancy-flow';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { paletteKindFilter } from '../src/core/flow-canvas.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { parseRoute } from '../src/core/route.js';
import type { FlowRecord, FlowRun } from '../src/main/flow-store.js';
import { SERVABLE } from '../src/renderer/bridge.js';
import { FlowEditorWindow, FlowRunOverlay, ScheduleInspector } from '../src/renderer/components/FlowEditorWindow.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * THE FLOW EDITOR WINDOW (genie#1204 item 1). Genie 1 edited a flow on fancy-flow's canvas in a window of its own
 * (renderer/pages/flow-editor.tsx, FlowEditorPanel.tsx at v0.7.0-beta.342); Genie 2 had a list and a form. Rendered here
 * with the canvas stubbed to capture what Genie hands it — the canvas itself is fancy-flow's — and the palette rendered
 * for real.
 */

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const n = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const flow = (over: Partial<FlowRecord> = {}): FlowRecord => ({
    id: 'flow_a', workspaceId: 'tynn', name: 'nightly report', armed: false,
    document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [n('t', 'schedule_trigger', { cron: '0 3 * * *' }), n('s', 'genie/terminal_run', { workspace: 'tynn', command: 'npm run report' }, 240), n('k', 'genie/knowledge_add', { workspace: 'gone', title: 'Report' }, 480)], edges: [{ id: 'e1', source: 't', target: 's' }, { id: 'e2', source: 's', target: 'k' }] } },
    createdBy: { kind: 'user' }, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', refusals: [], runs: [],
    ...over,
});
const data = (flows: FlowRecord[]): FeatureData => ({ ...EMPTY_FEATURES, flows: { flows, adding: null } });
const workspaces = [{ id: 'tynn', path: '/w/tynn' }];

function captured(f: FlowRecord | null, workspaceId: string | null = null) {
    const props: Array<Record<string, unknown>> = [];
    const Editor = (p: Record<string, unknown>) => { props.push(p); return <div data-stub-editor="" />; };
    const html = renderToStaticMarkup(<FlowEditorWindow flowId={f?.id ?? null} workspaceId={workspaceId} data={data(f ? [f] : [])} workspaces={workspaces} act={async () => data([])} Editor={Editor} now={NOW} />);
    return { html, props: props.at(-1)! };
}

describe('the editor window', () => {
    it('opens a flow on fancy-flow’s canvas: its graph, the name, Save — and the canvas never runs it (Genie’s runner does)', () => {
        const { html, props } = captured(flow());
        const value = props.value as { nodes: Array<{ id: string }> };
        expect(value.nodes.map((x) => x.id)).toEqual(['t', 's', 'k']);
        expect(html).toContain('value="nightly report"');
        expect(html).toMatch(/<button[^>]*>Save<\/button>/);
        expect((props.builtins as { run?: boolean }).run).toBe(false);
        expect(props.executors).toBeUndefined();
    });

    it('the palette is the supported kinds: the editor gets Genie’s filter, and the real palette lists them — and not what cannot run', () => {
        const { props } = captured(flow());
        expect(props.kindFilter).toBe(paletteKindFilter);
        const palette = renderToStaticMarkup(<NodePalette kindFilter={paletteKindFilter} />);
        for (const label of ['Manual', 'Schedule', 'A file is added', 'Prompt an agent', 'Run a command', 'Add knowledge', 'Move a file', 'Branch', 'Switch', 'Merge', 'Transform', 'Variable', 'Wait', 'Log', 'Output', 'Note']) expect(palette).toContain(label);
        for (const label of ['Webhook', 'Human Approval', 'LLM Call', 'API Request', 'Subflow']) expect(palette).not.toContain(label);
    });

    it('a problem is drawn ON its node, with the reason, and listed by step', () => {
        const { html, props } = captured(flow());
        const k = (props.value as { nodes: Array<{ id: string; data: Record<string, unknown> }> }).nodes.find((x) => x.id === 'k')!;
        expect(k.data).toMatchObject({ status: 'error', statusText: 'there is no workspace "gone" in Genie' });
        expect(html).toContain('data-flow-problem="k"');
        expect(html).toContain('there is no workspace &quot;gone&quot; in Genie');
    });

    it('a new flow opens on a starting canvas in its workspace', () => {
        const { props, html } = captured(null, 'tynn');
        expect((props.value as { nodes: Array<{ id: string }> }).nodes.map((x) => x.id)).toEqual(['trigger']);
        expect(html).toContain('placeholder="Name this flow"');
    });

    it('an armed flow says a change to what it does disarms it', () => {
        expect(captured(flow({ armed: true })).html).toMatch(/Armed\. Saving a change to what it does disarms it/);
    });

    it('a flow imported from Genie 1 opens with its full graph', () => {
        const imported = flow({ id: 'flow_v1_s-report', importedFrom: { v1SpecId: 's-report' }, document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [n('t', 'schedule_trigger', { cron: '*/30 * * * *' }), n('s', 'genie/agent_prompt', { agent: 'tynn:claude:atlas', prompt: 'check the queue' }, 240)], edges: [{ id: 'e1', source: 't', target: 's' }] } } });
        const value = captured(imported).props.value as { nodes: Array<{ id: string; data: { kind: string; config: Record<string, unknown> } }>; edges: unknown[] };
        expect(value.nodes.map((x) => [x.id, x.data.config])).toEqual([['t', expect.objectContaining({ cron: '*/30 * * * *' })], ['s', expect.objectContaining({ prompt: 'check the queue' })]]);
        expect(value.edges).toHaveLength(1);
    });

    it('the schedule trigger’s inspector offers the presets and says when it next runs', () => {
        const html = renderToStaticMarkup(<ScheduleInspector cron="0 3 * * *" now={NOW} onCron={() => {}} />);
        expect(html).toContain('Every day at 03:00');
        expect(html).toContain('Every 15 minutes');
        expect(html).toMatch(/Next run: /);
    });
});

describe('a run on the canvas, read-only', () => {
    const run: FlowRun = { at: '2026-10-26T03:00:00.000Z', endedAt: '2026-10-26T03:00:05.000Z', trigger: 'schedule', outcome: 'failed', reason: 'npm run report ended with exit code 2', nodes: { t: 'ran', s: 'failed', k: 'not reached' } };

    it('draws which node ran, failed or was not reached on the flow’s own graph, in a viewer that cannot edit', () => {
        const seen: Array<Record<string, unknown>> = [];
        const Viewer = (p: Record<string, unknown>) => { seen.push(p); return <div data-stub-viewer="" />; };
        const html = renderToStaticMarkup(<FlowRunOverlay flow={flow({ runs: [run] })} run={run} Viewer={Viewer} />);
        expect(seen[0]!.statuses).toEqual({ t: 'ok', s: 'failed', k: 'pending' });
        expect((seen[0]!.graph as { nodes: unknown[] }).nodes).toHaveLength(3);
        expect(seen[0]!.onSelectNode).toBeUndefined();
        expect(html).toContain('npm run report ended with exit code 2');
        expect([...html.matchAll(/data-flow-node-outcome="([^"]+)"/g)].map((m) => m[1])).toEqual(['ran', 'failed', 'not reached']);
    });
});

describe('the route', () => {
    it('genie://flow/<id> and genie://flow/new?workspace=<id> are the editor window', () => {
        expect(parseRoute('genie://flow/flow_a')).toMatchObject({ surface: 'flow', flowId: 'flow_a', workspaceId: null });
        expect(parseRoute('genie://flow/new?workspace=tynn')).toMatchObject({ surface: 'flow', flowId: null, workspaceId: 'tynn' });
        expect(SERVABLE).toContain('flow');
    });
});
