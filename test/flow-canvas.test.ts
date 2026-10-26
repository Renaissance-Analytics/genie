import { getNodeKind, listNodeKinds } from '@particle-academy/fancy-flow/engine';
import { describe, expect, it } from 'vitest';
import {
    SUPPORTED_KINDS,
    documentToGraph,
    findCycle,
    graphToDocument,
    isSupportedKind,
    paletteKindFilter,
    saveProblems,
    structuralProblems,
    viewerStatuses,
    waitMs,
    withProblems,
} from '../src/core/flow-canvas.js';
import { flowEditorPanes } from '../src/core/flow-editor-layout.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';

/**
 * THE CANVAS'S VOCABULARY AND RULES (genie#1204 item 1). The palette offers exactly what Genie's runner executes, and a
 * save refuses — on the node, with the reason — what could not run. Genie 1 offered kinds that could never run (its
 * webhook trigger was "recognised, never armable"); this pins that it cannot happen here.
 */

const node = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const doc = (nodes: unknown[], edges: unknown[] = []) => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } });
const ctx = { workspaces: ['ws-example'], agentProblem: (a: string) => (a === 'atlas@ws-example' ? null : `no agent answers to ${a}`) };

describe('the palette', () => {
    it('offers exactly the kinds Genie runs — every one registered — and none it cannot', () => {
        // Genie's kinds are registered by the module (ensureGenieKinds), fancy-flow's by the package.
        isSupportedKind('genie/agent_prompt');
        const offered = listNodeKinds().filter((kind) => paletteKindFilter({ kind })).map((k) => k.name).sort();
        expect(offered).toEqual([...SUPPORTED_KINDS].sort());
        for (const name of SUPPORTED_KINDS) expect(getNodeKind(name)?.name).toBe(name);
    });

    it('holds Genie’s steps, the schedule and file triggers, and the logic Genie runs', () => {
        for (const name of ['genie/agent_prompt', 'genie/terminal_run', 'genie/knowledge_add', 'genie/file_move', 'genie/file_added', '@particle-academy/schedule_trigger', '@particle-academy/manual_trigger', '@particle-academy/branch', '@particle-academy/wait']) {
            expect(SUPPORTED_KINDS).toContain(name);
        }
    });

    it('leaves out what cannot run: the webhook trigger, the pausing human steps, model calls, arbitrary HTTP, nested runs', () => {
        for (const name of ['@particle-academy/webhook_trigger', '@particle-academy/human_approval', '@particle-academy/user_input', '@particle-academy/llm_call', '@particle-academy/api_request', '@particle-academy/subflow', '@particle-academy/for_each', '@particle-academy/terminal_run']) {
            expect(paletteKindFilter({ kind: { name } })).toBe(false);
        }
    });

    it('reads an alias as its kind (a stored `schedule_trigger` is the Schedule trigger)', () => {
        expect(isSupportedKind('schedule_trigger')).toBe(true);
        expect(isSupportedKind('branch')).toBe(true);
        expect(isSupportedKind('webhook_trigger')).toBe(false);
    });
});

describe('what a save refuses, on the node', () => {
    const good = doc([node('t', 'schedule_trigger', { cron: '0 3 * * *' }), node('s', 'genie/terminal_run', { workspace: 'ws-example', command: 'npm run report' }, 240)], [edge('t', 's')]);

    it('CONTROL: a runnable flow has no problems', () => {
        expect(saveProblems(good, ctx)).toEqual([]);
    });

    it('a kind Genie cannot run is refused on that node, naming it', () => {
        const p = structuralProblems(doc([node('t', 'manual_trigger'), node('w', 'webhook_out', { url: 'https://x' })], [edge('t', 'w')]));
        expect(p).toEqual([{ nodeId: 'w', message: expect.stringMatching(/is not a step Genie can run/) }]);
    });

    it('a loop is refused, naming the steps that form it', () => {
        const p = structuralProblems(doc([node('t', 'manual_trigger'), node('a', 'log', { message: 'a' }), node('b', 'log', { message: 'b' })], [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')]));
        expect(p).toEqual([{ nodeId: 'a', message: expect.stringMatching(/a → b → a form a loop/) }]);
        expect(findCycle([{ id: 'x' }, { id: 'y' }], [{ source: 'x', target: 'y' }])).toEqual([]);
    });

    it('a Wait Genie cannot honour is refused; a duration it can is not', () => {
        expect(structuralProblems(doc([node('t', 'manual_trigger'), node('w', 'wait', { mode: 'event' })], [edge('t', 'w')]))[0]).toMatchObject({ nodeId: 'w', message: expect.stringMatching(/duration only/) });
        expect(structuralProblems(doc([node('t', 'manual_trigger'), node('w', 'wait', { mode: 'duration', duration: 'soon' })], [edge('t', 'w')]))[0]).toMatchObject({ nodeId: 'w' });
        expect(structuralProblems(doc([node('t', 'manual_trigger'), node('w', 'wait', { mode: 'duration', duration: '5s' })], [edge('t', 'w')]))).toEqual([]);
        expect([waitMs('250ms'), waitMs('5s'), waitMs('10m'), waitMs('1h'), waitMs('25h'), waitMs('x')]).toEqual([250, 5000, 600000, 3600000, null, null]);
    });

    it('no trigger, no step, a schedule Genie cannot read, a workspace or agent that is not there — each said, on its node where it has one', () => {
        expect(saveProblems(doc([node('s', 'genie/terminal_run', { workspace: 'ws-example', command: 'x' })]), ctx).map((p) => p.message)).toContain('a flow needs something to start it: add a Manual, Schedule or "A file is added" trigger');
        expect(saveProblems(doc([node('t', 'manual_trigger')]), ctx).map((p) => p.message)).toContain('a flow needs at least one step after its trigger');
        expect(saveProblems(doc([node('t', 'schedule_trigger', { cron: 'every day' }), node('s', 'log', { message: 'x' })], [edge('t', 's')]), ctx)).toEqual([{ nodeId: 't', message: expect.stringMatching(/"every day" is not a schedule Genie can evaluate/) }]);
        expect(saveProblems(doc([node('t', 'manual_trigger'), node('s', 'genie/terminal_run', { workspace: 'nowhere', command: 'x' })], [edge('t', 's')]), ctx)).toEqual([{ nodeId: 's', message: 'there is no workspace "nowhere" in Genie' }]);
        expect(saveProblems(doc([node('t', 'manual_trigger'), node('s', 'genie/agent_prompt', { agent: 'ghost', prompt: 'hi' })], [edge('t', 's')]), ctx)).toEqual([{ nodeId: 's', message: 'no agent answers to ghost' }]);
    });
});

describe('the document and the canvas', () => {
    const stored = doc([node('t', 'schedule_trigger', { cron: '0 3 * * *' }), node('s', 'genie/terminal_run', { workspace: 'ws-example', command: 'npm run report' }, 240)], [edge('t', 's')]);

    it('a stored document opens as the engine’s graph and saves back as the same steps, config and edges', () => {
        const graph = documentToGraph(stored);
        expect(graph.nodes.map((n) => n.id)).toEqual(['t', 's']);
        const back = graphToDocument(graph) as unknown as { $schema: string; version: number; graph: { nodes: Array<{ id: string; kind: string; config?: unknown }>; edges: Array<{ source: string; target: string }> } };
        expect(back.$schema).toBe(FLOW_SCHEMA_URL);
        expect(back.version).toBe(1);
        expect(back.graph.nodes.map((n) => [n.id, getNodeKind(n.kind)?.name])).toEqual([['t', '@particle-academy/schedule_trigger'], ['s', 'genie/terminal_run']]);
        expect(back.graph.nodes[0]!.config).toMatchObject({ cron: '0 3 * * *' });
        expect(back.graph.nodes[1]!.config).toMatchObject({ workspace: 'ws-example', command: 'npm run report' });
        expect(back.graph.edges.map((e) => [e.source, e.target])).toEqual([['t', 's']]);
    });

    it('a problem is drawn ON its node (fancy-flow’s error ring and the reason) and never saved with it', () => {
        const drawn = withProblems(documentToGraph(stored), [{ nodeId: 's', message: 'there is no workspace "x" in Genie' }, { message: 'not on a node' }]);
        const s = drawn.nodes.find((n) => n.id === 's')!.data as Record<string, unknown>;
        expect(s).toMatchObject({ status: 'error', statusText: 'there is no workspace "x" in Genie' });
        expect((drawn.nodes.find((n) => n.id === 't')!.data as Record<string, unknown>).status).toBeUndefined();
        const saved = JSON.stringify(graphToDocument(drawn));
        expect(saved).not.toContain('statusText');
        expect(saved).not.toContain('there is no workspace');
    });

    it('a run’s node outcomes become the viewer’s statuses', () => {
        expect(viewerStatuses({ t: 'ran', a: 'failed', b: 'not reached', c: 'held', d: 'skipped', e: 'stopped' })).toEqual({ t: 'ok', a: 'failed', b: 'pending', c: 'running', d: 'skipped', e: 'failed' });
    });
});

describe('the editor measures itself (genie#505: the canvas must never clip)', () => {
    it('wide: palette, canvas and inspector side by side; narrow: the canvas keeps its room and a pane opens on request', () => {
        expect(flowEditorPanes(1400, null)).toMatchObject({ showPalette: true, showPanel: true, columns: 'auto 1fr auto' });
        expect(flowEditorPanes(800, null)).toMatchObject({ showPalette: true, showPanel: false, columns: 'auto 1fr' });
        expect(flowEditorPanes(800, 'panel')).toMatchObject({ showPalette: true, showPanel: true, columns: 'auto 1fr auto' });
        expect(flowEditorPanes(500, null)).toMatchObject({ showPalette: false, showPanel: false, columns: '1fr' });
        expect(flowEditorPanes(500, 'palette')).toMatchObject({ showPalette: true, showPanel: false, columns: 'auto 1fr' });
    });
});
