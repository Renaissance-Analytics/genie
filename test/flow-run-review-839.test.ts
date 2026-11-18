import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import {
    NOT_RECORDED,
    STEP_OUTPUT_LIMIT,
    boundStepDetail,
    formatDuration,
    mergeStep,
    runCanvasGraph,
    runHeader,
    runRows,
    takenEdges,
    type ReviewedRun,
} from '../src/core/flow-run-review.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { createFlowRunner } from '../src/main/flow-runner.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore } from '../src/main/flow-store.js';
import { flowTools } from '../src/main/mcp-tools-flows.js';

/**
 * REVIEWING A FLOW RUN (Tynn #839; the owner: "reviewing flow runs needs to give me more info than this"). A run used to
 * keep one word per node ("ran", "skipped"): no timing, no output, no exit code, no prompt, no reply, no error. Each run
 * now records a TIMELINE — every step's start and end, its error in full, and by kind: a command's exit code, this run's
 * output and its process; a prompt's recipient, exact text, delivery and reply; the way a branch went and why — and who
 * pressed Run now. A run recorded before this has none of it, and the review says "not recorded" rather than guessing.
 */

const WS = { id: 'ws-example', path: resolve(tmpdir(), 'genie2-run-review-ws') };
const node = (id: string, kind: string, config: Record<string, unknown>, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const doc = (nodes: unknown[], edges: unknown[]) => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } });

// The owner's flow from the screenshot, in small: a command, a branch on its exit code, a prompt down `true`, a log down `false`.
const reviewFlow = doc(
    [
        node('t', 'schedule_trigger', { cron: '*/30 * * * *' }),
        node('r', 'genie/terminal_run', { workspace: WS.id, command: 'bash .ai/bin/learning-watch.sh', allowFailure: true }, 200),
        node('b', '@particle-academy/branch', { match: 'all', conditions: [{ left: '{{ $json.exitCode }}', operator: 'eq', right: '10' }] }, 400),
        node('p', 'genie/agent_prompt', { agent: 'atlas@ws-example', prompt: 'review the learning log: {{ in.exitCode }}', waitForReply: true }, 600),
        node('x', '@particle-academy/log', { level: 'info', message: 'nothing new' }, 600),
    ],
    [edge('t', 'r'), edge('r', 'b'), edge('b', 'p', 'true'), edge('b', 'x', 'false')],
);
const ports = (over: Partial<FlowPorts> = {}): FlowPorts => ({
    promptAgent: async (_address, text, hooks, options) => {
        hooks?.delivered?.('delivered', 'delivered to atlas');
        return options?.waitForReply ? `atlas read: ${text}` : '';
    },
    runCommand: async () => ({ exitCode: 10, output: 'line 1\nline 2\nnew entries: 3\n', processId: 'flow-run:flow_review' }),
    addKnowledge: async () => ({ id: 'kn_1' }),
    ...over,
});

describe('the run store records each step (Tynn #839)', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-run-review-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    const runOnce = async (p: FlowPorts = ports(), by?: { kind: 'agent'; id: string; name: string }) => {
        const store = await FlowStore.open(dir);
        const made = await store.create({ workspaceId: WS.id, name: 'learning watch', document: reviewFlow, by: { kind: 'user' } });
        let t = Date.parse('2026-11-17T19:30:00.000Z');
        const now = () => (t += 250);
        const scheduler = new FlowScheduler({ store, now, schedule: () => () => {}, run: createFlowRunner({ ports: () => p, asleep: () => false, now }) });
        await (by ? scheduler.runNow(made.id, by) : scheduler.runNow(made.id));
        return { store, id: made.id, run: store.get(made.id)!.runs.at(-1)! };
    };
    const stepOf = (run: { timeline?: readonly { nodeId: string }[] }, id: string) => run.timeline?.find((s) => s.nodeId === id) as Record<string, unknown> | undefined;

    it('a command step: what ran, its exit code, THIS run’s output and the process that keeps the whole log', async () => {
        const { run } = await runOnce();
        expect(stepOf(run, 'r')).toMatchObject({ command: { command: 'bash .ai/bin/learning-watch.sh', exitCode: 10, output: 'line 1\nline 2\nnew entries: 3\n', processId: 'flow-run:flow_review' } });
    });

    it('every step that ran has its start and end, in order', async () => {
        const { run } = await runOnce();
        const r = stepOf(run, 'r')!;
        const p = stepOf(run, 'p')!;
        expect(typeof r.startedAt).toBe('string');
        expect(Date.parse(r.endedAt as string)).toBeGreaterThan(Date.parse(r.startedAt as string));
        expect(Date.parse(p.startedAt as string)).toBeGreaterThanOrEqual(Date.parse(r.endedAt as string));
    });

    it('a prompt step: the recipient, the exact text sent (templated), what became of it and when, and the reply', async () => {
        const { run } = await runOnce();
        expect(stepOf(run, 'p')).toMatchObject({ prompt: { agent: 'atlas@ws-example', text: 'review the learning log: 10', delivery: 'delivered', reply: 'atlas read: review the learning log: 10' } });
        expect(typeof (stepOf(run, 'p')!.prompt as { deliveredAt?: unknown }).deliveredAt).toBe('string');
    });

    it('a branch step: the way it went, and the condition it read', async () => {
        const { run } = await runOnce();
        const route = stepOf(run, 'b')!.route as { port: string; condition?: string };
        expect(route.port).toBe('true');
        expect(route.condition).toContain('{{ $json.exitCode }}');
        expect(route.condition).toContain('10');
    });

    it('a failed step keeps its error in full, and its exit code and output too', async () => {
        const failing = doc([node('t', 'manual_trigger', {}), node('r', 'genie/terminal_run', { workspace: WS.id, command: 'npm test' }, 200)], [edge('t', 'r')]);
        const store = await FlowStore.open(dir);
        const made = await store.create({ workspaceId: WS.id, name: 'tests', document: failing, by: { kind: 'user' } });
        const scheduler = new FlowScheduler({ store, now: Date.now, schedule: () => () => {}, run: createFlowRunner({ ports: () => ports({ runCommand: async () => ({ exitCode: 2, output: 'FAIL 3 tests\n', processId: 'flow-run:x' }) }), asleep: () => false }) });
        await scheduler.runNow(made.id);
        const r = stepOf(store.get(made.id)!.runs.at(-1)!, 'r')!;
        expect(r.error).toBe('npm test ended with exit code 2');
        expect(r.command).toMatchObject({ exitCode: 2, output: 'FAIL 3 tests\n' });
    });

    it('a skipped step has no times: it never started', async () => {
        const { run } = await runOnce();
        expect(run.nodes?.x).toBe('skipped');
        expect(stepOf(run, 'x')?.startedAt).toBeUndefined();
    });

    it('Run now records who pressed it: the person by default', async () => {
        const { run } = await runOnce();
        expect(run.startedBy).toEqual({ kind: 'user' });
    });

    it('Run now by an agent records the agent', async () => {
        const { run } = await runOnce(ports(), { kind: 'agent', id: 'agent_atlas', name: 'atlas' });
        expect(run.startedBy).toEqual({ kind: 'agent', id: 'agent_atlas', name: 'atlas' });
    });

    it('the agents’ `flows runNow` passes the calling agent as who started it', async () => {
        const store = await FlowStore.open(dir);
        const made = await store.create({ workspaceId: WS.id, name: 'learning watch', document: reviewFlow, by: { kind: 'user' }, armed: true });
        const seen: unknown[] = [];
        const tools = flowTools({
            resolveCaller: (id) => (id === 't-atlas' ? { agentId: 'agent_atlas', agentName: 'atlas', workspaceId: WS.id, workspacePath: WS.path } as never : null),
            flows: { store, runNow: async (id, by) => { seen.push(by); return store.get(id)!.runs[0]!; } },
        });
        const reg = tools.find((t) => t.definition.name === 'flows')!;
        const r = await reg.handler({ action: 'runNow', id: made.id, terminalId: 't-atlas' }, { server: 'genie', tool: 'flows', headers: {} });
        expect(r.isError).toBe(false);
        expect(seen).toEqual([{ kind: 'agent', id: 'agent_atlas', name: 'atlas' }]);
    });
});

describe('a step is bounded for the store', () => {
    it('a long output keeps its TAIL and says how much was cut', () => {
        const output = 'x'.repeat(STEP_OUTPUT_LIMIT + 500) + 'THE END';
        const b = boundStepDetail({ nodeId: 'r', command: { command: 'npm test', output } });
        expect(b.command!.output!.length).toBe(STEP_OUTPUT_LIMIT);
        expect(b.command!.output!.endsWith('THE END')).toBe(true);
        expect(b.command!.outputCut).toBe(output.length - STEP_OUTPUT_LIMIT);
    });

    it('CONTROL: a short output is kept whole, with nothing cut', () => {
        const b = boundStepDetail({ nodeId: 'r', command: { command: 'npm test', output: 'ok\n' } });
        expect(b.command).toEqual({ command: 'npm test', output: 'ok\n' });
    });

    it('patches merge field by field: a command’s result keeps the command it started with', () => {
        const a = mergeStep({ nodeId: 'r' }, { startedAt: 'A', command: { command: 'npm test', cwd: 'app' } });
        const b = mergeStep(a, { endedAt: 'B', command: { command: 'npm test', exitCode: 0, output: 'ok' } });
        expect(b).toEqual({ nodeId: 'r', startedAt: 'A', endedAt: 'B', command: { command: 'npm test', cwd: 'app', exitCode: 0, output: 'ok' } });
    });
});

describe('the review reads a run', () => {
    const at = '2026-11-17T19:30:00.000Z';
    const run: ReviewedRun = {
        at, endedAt: '2026-11-17T19:30:04.200Z', trigger: 'schedule', outcome: 'ran',
        nodes: { t: 'ran', r: 'ran', b: 'ran', p: 'delivered', x: 'skipped' },
        timeline: [
            { nodeId: 'p', startedAt: '2026-11-17T19:30:02.000Z', endedAt: '2026-11-17T19:30:04.000Z' },
            { nodeId: 't', startedAt: '2026-11-17T19:30:00.000Z', endedAt: '2026-11-17T19:30:00.010Z' },
            { nodeId: 'r', startedAt: '2026-11-17T19:30:00.020Z', endedAt: '2026-11-17T19:30:01.900Z', command: { command: 'bash x.sh', exitCode: 10 } },
            { nodeId: 'b', startedAt: '2026-11-17T19:30:01.950Z', endedAt: '2026-11-17T19:30:01.960Z', route: { port: 'true' } },
        ],
    };

    it('durations in words', () => {
        expect([formatDuration(350), formatDuration(4_200), formatDuration(185_000), formatDuration(3_720_000), formatDuration(null)]).toEqual(['350 ms', '4.2 s', '3 min 05 s', '1 h 02 min', NOT_RECORDED]);
    });

    it('the header: what started it, when, how long, how it ended, who', () => {
        expect(runHeader(run)).toMatchObject({ trigger: 'on schedule', durationMs: 4_200, outcome: 'ran', startedBy: 'Genie (its schedule)' });
        expect(runHeader({ ...run, trigger: 'manual', startedBy: { kind: 'user' } }).startedBy).toBe('you');
        expect(runHeader({ ...run, trigger: 'manual', startedBy: { kind: 'agent', id: 'a1', name: 'atlas' } }).startedBy).toBe('atlas');
        expect(runHeader({ ...run, trigger: 'file', file: 'inbox/a.pdf' })).toMatchObject({ trigger: 'a file was added: inbox/a.pdf', startedBy: 'Genie (a file was added)' });
    });

    it('an OLD Run now (before #839) says who started it was not recorded', () => {
        const { timeline: _t, ...old } = run;
        expect(runHeader({ ...old, trigger: 'manual' }).startedBy).toBe(NOT_RECORDED);
    });

    it('rows: the steps that started, in the order they started; then the rest in graph order', () => {
        const rows = runRows(['t', 'r', 'b', 'p', 'x'], run);
        expect(rows.map((r) => r.nodeId)).toEqual(['t', 'r', 'b', 'p', 'x']);
        expect(rows.find((r) => r.nodeId === 'r')).toMatchObject({ outcome: 'ran', startedAt: '2026-11-17T19:30:00.020Z', durationMs: 1_880 });
        expect(rows.find((r) => r.nodeId === 'x')).toMatchObject({ outcome: 'skipped', startedAt: null, durationMs: null, detail: null });
    });

    it('an OLD run (no timeline) still lists every step with its outcome, times not recorded', () => {
        const { timeline: _t, ...old } = run;
        const rows = runRows(['t', 'r', 'b', 'p', 'x'], old);
        expect(rows.map((r) => [r.nodeId, r.outcome, r.startedAt, r.durationMs])).toEqual([['t', 'ran', null, null], ['r', 'ran', null, null], ['b', 'ran', null, null], ['p', 'delivered', null, null], ['x', 'skipped', null, null]]);
    });

    const edges = [edge('t', 'r'), edge('r', 'b'), edge('b', 'p', 'true'), edge('b', 'x', 'false')];

    it('the path taken: into every step reached, and out of a branch only along the way it went', () => {
        expect([...takenEdges(edges, run)].sort()).toEqual(['b-p', 'r-b', 't-r']);
    });

    it('an OLD run with no recorded way still highlights by what was reached', () => {
        const { timeline: _t, ...old } = run;
        expect([...takenEdges(edges, old)].sort()).toEqual(['b-p', 'r-b', 't-r']);
    });

    it('a failed step: the path stops there', () => {
        const failed: ReviewedRun = { ...run, outcome: 'failed', nodes: { t: 'ran', r: 'failed', b: 'not reached', p: 'not reached', x: 'not reached' }, timeline: [] };
        expect([...takenEdges(edges, failed)]).toEqual(['t-r']);
    });

    it('the canvas graph: each node’s status, a class for its outcome, the selected one; taken edges highlighted', () => {
        const graph = { nodes: ['t', 'r', 'b', 'p', 'x'].map((id) => ({ id, data: { kind: 'k', label: id } })), edges };
        const drawn = runCanvasGraph(graph, run, 'r');
        const n = (id: string) => drawn.nodes.find((x) => x.id === id) as { data: { status?: string; statusText?: string }; className?: string; selected?: boolean };
        expect(n('r').data.status).toBe('done');
        expect(n('r').className).toContain('genie-run-node--ran');
        expect(n('r').selected).toBe(true);
        expect(n('t').selected).toBe(false);
        expect(n('x').className).toContain('genie-run-node--skipped');
        expect(n('p').className).toContain('genie-run-node--delivered');
        expect(n('r').data.statusText).toContain('1.9 s');
        const e = (id: string) => drawn.edges.find((x) => x.id === id) as { className?: string };
        expect(e('b-p').className).toContain('genie-run-edge--taken');
        expect(e('b-x').className ?? '').not.toContain('genie-run-edge--taken');
    });
});
