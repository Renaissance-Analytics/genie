// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowRecord, FlowRun } from '../src/main/flow-store.js';
import { FlowRunOverlay, RunCanvas } from '../src/renderer/components/FlowEditorWindow.js';

/**
 * THE RUN REVIEW, ON SCREEN (Tynn #839). The owner's screenshot: a run picked in the Flow window showed a blank canvas the
 * size of the window and five plain lines at the bottom. Now the run fills it: a header (what started it, when, how long,
 * how it ended, who; Re-run, Stop, the run before and after), the flow drawn AS the run, and a timeline of its steps with
 * what each did. Picking a step on either side picks it on the other.
 */

const node = (id: string, kind: string, config: Record<string, unknown>, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const flow = (over: Partial<FlowRecord> = {}): FlowRecord => ({
    id: 'flow_review', workspaceId: 'ws-example', name: 'learning watch', armed: true,
    document: {
        $schema: FLOW_SCHEMA_URL, version: 1,
        graph: {
            nodes: [
                node('t', 'schedule_trigger', { cron: '*/30 * * * *' }),
                node('r', 'genie/terminal_run', { workspace: 'ws-example', command: 'bash .ai/bin/learning-watch.sh' }, 200),
                node('b', '@particle-academy/branch', { match: 'all', conditions: [{ left: '{{ $json.exitCode }}', operator: 'eq', right: '10' }] }, 400),
                node('p', 'genie/agent_prompt', { agent: 'atlas@ws-example', prompt: 'review the learning log' }, 600),
                node('x', '@particle-academy/log', { level: 'info', message: 'nothing new' }, 600),
            ],
            edges: [edge('t', 'r'), edge('r', 'b'), edge('b', 'p', 'true'), edge('b', 'x', 'false')],
        },
    },
    createdBy: { kind: 'user' }, createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z', refusals: [], runs: [],
    ...over,
});
const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
const run: FlowRun = {
    at: '2026-11-17T19:30:00.000Z', endedAt: '2026-11-17T19:30:04.200Z', trigger: 'manual', outcome: 'ran',
    startedBy: { kind: 'agent', id: 'agent_atlas', name: 'atlas' },
    nodes: { t: 'ran', r: 'ran', b: 'ran', p: 'delivered', x: 'skipped' },
    timeline: [
        { nodeId: 't', startedAt: '2026-11-17T19:30:00.000Z', endedAt: '2026-11-17T19:30:00.010Z' },
        { nodeId: 'r', startedAt: '2026-11-17T19:30:00.020Z', endedAt: '2026-11-17T19:30:01.900Z', command: { command: 'bash .ai/bin/learning-watch.sh', exitCode: 10, output: LONG, processId: 'flow-run:flow_review' } },
        { nodeId: 'b', startedAt: '2026-11-17T19:30:01.950Z', endedAt: '2026-11-17T19:30:01.960Z', route: { port: 'true', condition: 'all: {{ $json.exitCode }} eq 10' } },
        { nodeId: 'p', startedAt: '2026-11-17T19:30:02.000Z', endedAt: '2026-11-17T19:30:04.000Z', prompt: { agent: 'atlas@ws-example', text: 'review the learning log', delivery: 'delivered', deliveredAt: '2026-11-17T19:30:03.000Z', reply: 'three new entries, filed' } },
    ],
};
const stub = (seen: Array<Record<string, unknown>>) => (p: Record<string, unknown>) => { seen.push(p); return <div data-stub-canvas="" />; };
const html = (r: FlowRun = run, over: Partial<FlowRecord> = {}, props: Record<string, unknown> = {}) => renderToStaticMarkup(<FlowRunOverlay flow={flow({ runs: [r], ...over })} run={r} Viewer={stub([])} {...props} />);
const attr = (h: string, name: string) => new RegExp(`${name}="[^"]*"[^>]*>([^<]*)<`).exec(h)?.[1];

describe('the run header', () => {
    it('what started it, when it started and finished, how long, how it ended, and who', () => {
        const h = html();
        expect(h).toContain('data-run-header');
        expect(attr(h, 'data-run-trigger')).toBe('Run now');
        expect(attr(h, 'data-run-duration')).toBe('4.2 s');
        expect(attr(h, 'data-run-status')).toBe('ran');
        expect(attr(h, 'data-run-started-by')).toBe('atlas');
        expect(h).toMatch(/data-run-started="2026-11-17T19:30:00.000Z"/);
        expect(h).toMatch(/data-run-finished="2026-11-17T19:30:04.200Z"/);
    });

    it('Re-run, and the run before and after, are buttons; one with nothing to do is disabled', () => {
        const h = html(run, {}, { onRerun: () => {}, onPrevious: () => {} });
        expect(h).toMatch(/<button[^>]*data-run-rerun/);
        expect(h).toMatch(/<button[^>]*data-run-previous(?![^>]*disabled)/);
        expect(h).toMatch(/<button[^>]*data-run-next[^>]*disabled|<button[^>]*disabled[^>]*data-run-next/);
    });

    it('a run going now offers Stop', () => {
        const going = html(run, { inFlight: { at: '2026-11-17T20:00:00.000Z', trigger: 'schedule', nodes: { r: 'running' } } }, { onStop: () => {} });
        expect(going).toMatch(/<button[^>]*data-run-stop/);
    });

    it('CONTROL: no run going, no Stop', () => {
        expect(html(run, {}, { onStop: () => {} })).not.toContain('data-run-stop');
    });

    it('an OLD run (before #839): who started it is "not recorded"', () => {
        const { startedBy: _s, timeline: _t, ...old } = run;
        expect(attr(html(old as FlowRun), 'data-run-started-by')).toBe('not recorded');
    });
});

describe('the step timeline', () => {
    const rowOf = (h: string, id: string) => {
        const start = h.indexOf(`data-flow-node="${id}"`);
        const next = h.indexOf('data-flow-node="', start + 10);
        return h.slice(start, next < 0 ? undefined : next);
    };

    it('every step: its name, outcome, start time and duration', () => {
        const r = rowOf(html(), 'r');
        expect(r).toContain('data-flow-node-outcome="ran"');
        expect(r).toContain('data-step-start=');
        expect(attr(r, 'data-step-duration')).toBe('1.9 s');
        expect(r).toContain('runs the command');
    });

    it('a command: the command, exit code, the output’s last lines, the whole output on expand, and where the log is kept', () => {
        const r = rowOf(html(), 'r');
        expect(attr(r, 'data-step-exit')).toBe('10');
        expect(r).toContain('bash .ai/bin/learning-watch.sh');
        const tail = /data-step-output="tail"[^>]*>([^<]*)</.exec(r)?.[1] ?? '';
        expect(tail).toContain('line 40');
        expect(tail).not.toContain('line 1\n');
        expect(r).toMatch(/<details[^>]*data-step-full-log/);
        expect(/data-step-output="full"[^>]*>([^<]*)</.exec(r)?.[1]).toContain('line 1\n');
        expect(r).toContain('flow-run:flow_review');
    });

    it('a prompt: the exact text, the recipient, when it was delivered, and the reply', () => {
        const r = rowOf(html(), 'p');
        expect(attr(r, 'data-step-prompt')).toBe('review the learning log');
        expect(attr(r, 'data-step-recipient')).toBe('atlas@ws-example');
        expect(r).toContain('data-step-delivered=');
        expect(attr(r, 'data-step-reply')).toBe('three new entries, filed');
    });

    it('a branch: the condition, and which way it went', () => {
        const r = rowOf(html(), 'b');
        expect(r).toContain('{{ $json.exitCode }} eq 10');
        expect(attr(r, 'data-step-route')).toBe('true');
    });

    it('an error, in full', () => {
        const failed: FlowRun = { ...run, outcome: 'failed', reason: 'bash .ai/bin/learning-watch.sh ended with exit code 2', nodes: { ...run.nodes, r: 'failed', b: 'not reached', p: 'not reached', x: 'not reached' }, timeline: [{ nodeId: 'r', startedAt: run.at, endedAt: run.endedAt, error: 'bash .ai/bin/learning-watch.sh ended with exit code 2' }] };
        expect(attr(rowOf(html(failed), 'r'), 'data-step-error')).toBe('bash .ai/bin/learning-watch.sh ended with exit code 2');
    });

    it('an OLD run: each step with its outcome, and what it lacks "not recorded"', () => {
        const { timeline: _t, ...old } = run;
        const r = rowOf(html(old as FlowRun), 'r');
        expect(r).toContain('data-flow-node-outcome="ran"');
        expect(attr(r, 'data-step-duration')).toBe('not recorded');
    });
});

describe('the canvas shows the run', () => {
    it('it is handed the run’s graph: statuses and classes by outcome, the taken path highlighted, and a way to pick a step', () => {
        const seen: Array<Record<string, unknown>> = [];
        renderToStaticMarkup(<FlowRunOverlay flow={flow({ runs: [run] })} run={run} Viewer={stub(seen)} />);
        const g = seen[0]!.graph as { nodes: Array<{ id: string; className?: string; data: { status?: string } }>; edges: Array<{ id: string; className?: string }> };
        expect(g.nodes.find((n) => n.id === 'r')!.className).toContain('genie-run-node--ran');
        expect(g.nodes.find((n) => n.id === 'x')!.className).toContain('genie-run-node--skipped');
        expect(g.edges.find((e) => e.id === 'b-p')!.className).toContain('genie-run-edge--taken');
        expect(typeof seen[0]!.onSelectNode).toBe('function');
    });

    it('the canvas is given a PIXEL height and fits the view, never "100%" of a box with no height (the blank canvas)', () => {
        const seen: Array<Record<string, unknown>> = [];
        renderToStaticMarkup(<RunCanvas graph={{ nodes: [], edges: [] } as never} Canvas={stub(seen)} />);
        expect(typeof seen[0]!.height).toBe('number');
        expect(seen[0]!.height as number).toBeGreaterThan(0);
        expect(seen[0]!.fitView).toBe(true);
        expect(seen[0]!.nodesDraggable).toBe(false);
    });
});

describe('picking a step', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

    it('a row picks its node on the canvas, and a node on the canvas picks its row', () => {
        const seen: Array<Record<string, unknown>> = [];
        act(() => root.render(<FlowRunOverlay flow={flow({ runs: [run] })} run={run} Viewer={stub(seen)} />));
        const row = host.querySelector('[data-flow-node="r"]')!;
        act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(seen.at(-1)!.selectedNodeId).toBe('r');
        expect(row.getAttribute('aria-current')).toBe('true');
        act(() => { (seen.at(-1)!.onSelectNode as (n: { id: string }) => void)({ id: 'p' }); });
        expect(host.querySelector('[data-flow-node="p"]')!.getAttribute('aria-current')).toBe('true');
        expect(host.querySelector('[data-flow-node="r"]')!.getAttribute('aria-current')).toBeNull();
    });

    it('Re-run and the run after call what they are given', () => {
        const onRerun = vi.fn();
        const onNext = vi.fn();
        act(() => root.render(<FlowRunOverlay flow={flow({ runs: [run] })} run={run} Viewer={stub([])} onRerun={onRerun} onNext={onNext} />));
        act(() => { host.querySelector('[data-run-rerun]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        act(() => { host.querySelector('[data-run-next]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(onRerun).toHaveBeenCalledTimes(1);
        expect(onNext).toHaveBeenCalledTimes(1);
    });
});
