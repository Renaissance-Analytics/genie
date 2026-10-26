import { describe, expect, it } from 'vitest';
import { SUPPORTED_KINDS, canonicalKind, documentToGraph, graphToDocument, type NodeOutcome } from '../src/core/flow-canvas.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { createFlowRunner } from '../src/main/flow-runner.js';
import type { FileFired, FlowRecord, Schedule } from '../src/main/flow-store.js';

/**
 * EVERY KIND IN THE PALETTE RUNS (genie#1204, acceptance (a)). For each kind the canvas offers, a flow is built the way the
 * canvas builds it (the stored document opened as the canvas's graph and saved back through `graphToDocument`), run by
 * Genie's runner — fancy-flow's engine with Genie's executors — and its EFFECT is checked: a command run, an agent
 * prompted, a file moved, a branch taken, a value reshaped. Genie 1 offered kinds that never ran; a kind added to the
 * palette without an executor turns the guard at the bottom of this file red.
 */

const WS = 'ws-example';
const n = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const e = (source: string, target: string, sourceHandle?: string, targetHandle?: string) => ({ id: `${source}-${target}-${sourceHandle ?? ''}-${targetHandle ?? ''}`, source, target, ...(sourceHandle ? { sourceHandle } : {}), ...(targetHandle ? { targetHandle } : {}) });
/** Built as the canvas builds it: opened as its graph, saved back. */
const onCanvas = (nodes: unknown[], edges: unknown[]): Record<string, unknown> => graphToDocument(documentToGraph({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } })) as unknown as Record<string, unknown>;
const flowOf = (document: Record<string, unknown>): FlowRecord => ({ id: 'flow_k', workspaceId: WS, name: 'kinds', armed: true, document, createdBy: { kind: 'user' }, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', refusals: [], runs: [] });
const schedule: Schedule = { nodeId: 't', cron: '0 3 * * *', timezone: undefined };
const sink = (id: string, command: string, x = 600) => n(id, 'genie/terminal_run', { workspace: WS, command }, x);

function harness(over: Partial<FlowPorts> = {}) {
    const commands: string[] = [];
    const prompts: Array<[string, string]> = [];
    const knowledge: Array<{ title: string; body: string }> = [];
    const moves: Array<[string, string, string]> = [];
    const ports: FlowPorts = {
        runCommand: async (_ws, command) => { commands.push(command); return { exitCode: 0, output: '' }; },
        promptAgent: async (address, text) => { prompts.push([address, text]); return 'the standup is posted'; },
        addKnowledge: async (input) => { knowledge.push({ title: input.title, body: input.body }); return { id: 'kn_1' }; },
        moveFile: async (ws, from, to) => { moves.push([ws, from, to]); return { from, to: `${to}/a.png` }; },
        ...over,
    };
    const logs: string[] = [];
    let nodes: Record<string, NodeOutcome> = {};
    const run = (document: Record<string, unknown>, trigger: Schedule | FileFired | null = schedule) =>
        createFlowRunner({ ports: () => ports, asleep: () => false })(flowOf(document), trigger, { nodes: (m) => { nodes = m; }, log: (_id, line) => logs.push(line) });
    return { run, commands, prompts, knowledge, moves, logs, nodes: () => nodes };
}

describe('each palette kind runs, and does what it says', () => {
    it('Manual trigger: Run now starts the flow from it', async () => {
        const h = harness();
        expect(await h.run(onCanvas([n('t', 'manual_trigger'), sink('s', 'echo manual')], [e('t', 's')]), null)).toMatchObject({ outcome: 'ran' });
        expect(h.commands).toEqual(['echo manual']);
        expect(h.nodes()).toEqual({ t: 'ran', s: 'ran' });
    });

    it('Schedule trigger: hands on the schedule that fired', async () => {
        const h = harness();
        await h.run(onCanvas([n('t', 'schedule_trigger', { cron: '0 3 * * *' }), sink('s', 'echo {{in.cron}}')], [e('t', 's')]));
        expect(h.commands).toEqual(['echo 0 3 * * *']);
    });

    it('"A file is added" trigger and Move a file: the file that landed is moved, no shell', async () => {
        const h = harness();
        const file = { workspaceId: WS, path: '/w/uploads/a.png', relPath: 'uploads/a.png', name: 'a.png', extension: 'png', sizeBytes: 10 };
        await h.run(onCanvas([n('t', 'genie/file_added', { workspace: WS, folder: 'uploads' }), n('m', 'genie/file_move', { workspace: WS, from: '{{in.path}}', to: '.untracked' }, 240)], [e('t', 'm')]), { nodeId: 't', file });
        expect(h.moves).toEqual([[WS, '/w/uploads/a.png', '.untracked']]);
        expect(h.commands).toEqual([]);
    });

    it('Prompt an agent: the agent is prompted, and its reply goes on to the next step', async () => {
        const h = harness();
        await h.run(onCanvas([n('t', 'manual_trigger'), n('a', 'genie/agent_prompt', { agent: 'atlas@ws-example', prompt: 'post the standup' }, 240), n('k', 'genie/knowledge_add', { workspace: WS, title: 'Standup', body: '{{in.reply}}' }, 480)], [e('t', 'a'), e('a', 'k')]), null);
        expect(h.prompts).toEqual([['atlas@ws-example', 'post the standup']]);
        expect(h.knowledge).toEqual([{ title: 'Standup', body: 'the standup is posted' }]);
    });

    it('Run a command and Add knowledge: the command’s output becomes the knowledge', async () => {
        const h = harness({ runCommand: async (_w, command) => ({ exitCode: 0, output: `out of ${command}` }) });
        await h.run(onCanvas([n('t', 'manual_trigger'), sink('r', 'npm run report', 240), n('k', 'genie/knowledge_add', { workspace: WS, title: 'Report', body: '{{in.output}}' }, 480)], [e('t', 'r'), e('r', 'k')]), null);
        expect(h.knowledge).toEqual([{ title: 'Report', body: 'out of npm run report' }]);
    });

    it('Branch: the matching side runs, the other is skipped', async () => {
        const h = harness({ runCommand: async (_w, command) => (command === 'check' ? { exitCode: 10, output: '' } : (h2.push(command), { exitCode: 0, output: '' })) });
        const h2: string[] = [];
        await h.run(onCanvas([
            n('t', 'manual_trigger'),
            n('c', 'genie/terminal_run', { workspace: WS, command: 'check', allowFailure: true }, 200),
            n('b', 'branch', { match: 'all', conditions: [{ left: '{{in.exitCode}}', operator: 'eq', right: '10' }] }, 400),
            sink('yes', 'echo yes'), sink('no', 'echo no'),
        ], [e('t', 'c'), e('c', 'b'), e('b', 'yes', 'true'), e('b', 'no', 'false')]), null);
        expect(h2).toEqual(['echo yes']);
        expect(h.nodes()).toMatchObject({ b: 'ran', yes: 'ran', no: 'skipped' });
    });

    it('Switch: routes on a value to the port its case names', async () => {
        const h = harness({ runCommand: async (_w, command) => (command === 'what' ? { exitCode: 0, output: 'deploy' } : (seen.push(command), { exitCode: 0, output: '' })) });
        const seen: string[] = [];
        await h.run(onCanvas([
            n('t', 'manual_trigger'), sink('w', 'what', 200),
            n('s', 'switch_case', { value: '{{in.output}}', cases: { deploy: 'go' } }, 400),
            sink('go', 'echo go'), sink('other', 'echo other'),
        ], [e('t', 'w'), e('w', 's'), e('s', 'go', 'go'), e('s', 'other', 'default')]), null);
        expect(seen).toEqual(['echo go']);
    });

    it('Transform, Variable and Merge: values are reshaped, named and combined', async () => {
        const h = harness();
        await h.run(onCanvas([
            n('t', 'schedule_trigger', { cron: '0 3 * * *' }),
            n('x', 'transform', { mode: 'fields', fields: [{ key: 'when', value: '{{in.cron}}' }] }, 200),
            n('v', 'variable', { name: 'label', value: 'nightly' }, 200),
            n('m', 'merge', { mode: 'merge' }, 400),
            sink('s', 'echo {{in.when}} {{in.b}}'),
        ], [e('t', 'x'), e('t', 'v'), e('x', 'm', undefined, 'a'), e('v', 'm', undefined, 'b'), e('m', 's')]));
        expect(h.commands).toEqual(['echo 0 3 * * * nightly']);
    });

    it('Wait: the next step runs after the duration', async () => {
        const h = harness();
        const started = Date.now();
        await h.run(onCanvas([n('t', 'manual_trigger'), n('w', 'wait', { mode: 'duration', duration: '50ms' }, 200), sink('s', 'echo after')], [e('t', 'w'), e('w', 's')]), null);
        expect(h.commands).toEqual(['echo after']);
        expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    });

    it('Log and Output: the line is kept with the run; the output ends the flow', async () => {
        const h = harness();
        expect(await h.run(onCanvas([n('t', 'schedule_trigger', { cron: '0 3 * * *' }), n('l', 'log', { message: 'fired on {{in.cron}}' }, 200), n('o', 'output', {}, 400)], [e('t', 'l'), e('t', 'o')]))).toMatchObject({ outcome: 'ran' });
        expect(h.logs).toEqual(['fired on 0 3 * * *']);
        expect(h.nodes()).toMatchObject({ l: 'ran', o: 'ran' });
    });

    it('Note: an annotation the run walks past', async () => {
        const h = harness();
        expect(await h.run(onCanvas([n('t', 'manual_trigger'), n('note', 'note', { text: 'why this flow exists' }, 0), sink('s', 'echo ok')], [e('t', 's')]), null)).toMatchObject({ outcome: 'ran' });
        expect(h.commands).toEqual(['echo ok']);
        expect(h.nodes()).not.toHaveProperty('note');
    });

    it('GUARD: every palette kind is exercised above (a kind added to the palette needs a test here)', () => {
        const tested = ['manual_trigger', 'schedule_trigger', 'genie/file_added', 'genie/file_move', 'genie/agent_prompt', 'genie/knowledge_add', 'genie/terminal_run', 'branch', 'switch_case', 'transform', 'variable', 'merge', 'wait', 'log', 'output', 'note'].map(canonicalKind).sort();
        expect(tested).toEqual([...SUPPORTED_KINDS].sort());
    });
});
