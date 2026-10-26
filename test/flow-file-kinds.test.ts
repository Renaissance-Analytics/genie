import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { importFlowDocument } from '../src/main/flow-kinds.js';
import { createFlowRunner } from '../src/main/flow-runner.js';
import type { FlowRecord } from '../src/main/flow-store.js';

/**
 * THE FILE TRIGGER AND THE MOVE, AS FLOW KINDS (genie#1204 item 5). `genie/file_added` starts a flow when a file lands
 * in a workspace and hands the steps after it what landed (`{{in.path}}`, `{{in.sizeBytes}}`, …); `genie/file_move`
 * moves a file into a folder of the same workspace with no shell. The owner's reference case is the pair: a file over
 * 5 MB, anywhere in the workspace, moved to `.untracked`. A command step that templates a value in a flow a file starts
 * is REFUSED: a file name can carry `$(…)` or `;`.
 */

const WS = { id: 'ws-example', path: resolve(tmpdir(), 'genie2-file-kinds-ws') };
const doc = (nodes: unknown[], edges: unknown[] = []) => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } });
const node = (id: string, kind: string, config: Record<string, unknown>, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const fileTrigger = (config: Record<string, unknown> = {}) => node('t', 'genie/file_added', { workspace: WS.id, minSizeBytes: 5_000_000, ...config });
const move = (config: Record<string, unknown> = {}) => node('m', 'genie/file_move', { workspace: WS.id, from: '{{in.path}}', to: '.untracked', ...config }, 240);

describe('the kinds are known to the engine, and refused where they would be unsafe', () => {
    it('the owner\'s case is a valid flow: a file trigger with a minimum size, then a move', () => {
        const r = importFlowDocument(doc([fileTrigger(), move()], [edge('t', 'm')]));
        expect(r.ok ? [] : r.problems).toEqual([]);
    });

    it('a file trigger needs its workspace; a move needs a workspace, a file and a folder', () => {
        const noWs = importFlowDocument(doc([node('t', 'genie/file_added', { workspace: '  ' })]));
        expect(noWs.ok ? [] : noWs.problems.join('\n')).toMatch(/node t: workspace/);
        const noTo = importFlowDocument(doc([fileTrigger(), move({ to: '' })], [edge('t', 'm')]));
        expect(noTo.ok).toBe(false);
    });

    it('a command step that templates a value, in a flow a file starts, is refused — and says why', () => {
        const r = importFlowDocument(doc([fileTrigger(), node('s', 'genie/terminal_run', { workspace: WS.id, command: 'mv "{{in.path}}" .untracked/' }, 240)], [edge('t', 's')]));
        expect(r.ok).toBe(false);
        expect(r.ok ? '' : r.problems.join('\n')).toMatch(/node s: .*file name can carry shell syntax.*genie\/file_move/);
    });

    it('CONTROL: the same templated command in a SCHEDULED flow is accepted, and a file flow\'s plain command too', () => {
        const scheduled = importFlowDocument(doc([node('t', 'schedule_trigger', { cron: '0 3 * * *' }), node('s', 'genie/terminal_run', { workspace: WS.id, command: 'echo {{in.firedAt}}' }, 240)], [edge('t', 's')]));
        expect(scheduled.ok ? [] : scheduled.problems).toEqual([]);
        const plain = importFlowDocument(doc([fileTrigger(), node('s', 'genie/terminal_run', { workspace: WS.id, command: 'git status' }, 240)], [edge('t', 's')]));
        expect(plain.ok ? [] : plain.problems).toEqual([]);
    });
});

describe('a file run hands the file to the steps after the trigger', () => {
    const flow = (nodes: unknown[], edges: unknown[]): FlowRecord => ({
        id: 'flow_big', workspaceId: WS.id, name: 'big files out of git', document: doc(nodes, edges), armed: true,
        createdBy: { kind: 'user' }, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', refusals: [], runs: [],
    });
    const file = { workspaceId: WS.id, path: join(WS.path, 'uploads/big.png'), relPath: 'uploads/big.png', name: 'big.png', extension: 'png', sizeBytes: 6_000_000 };
    const ports = (over: Partial<FlowPorts> = {}): FlowPorts & { calls: unknown[][] } => {
        const calls: unknown[][] = [];
        return {
            calls,
            promptAgent: async (a, t) => { calls.push(['prompt', a, t]); return 'ok'; },
            runCommand: async () => ({ exitCode: 0, output: '' }),
            addKnowledge: async () => ({ id: 'kn' }),
            moveFile: async (workspaceId, from, to) => { calls.push(['move', workspaceId, from, to]); return { from, to: join(WS.path, to, 'big.png') }; },
            ...over,
        };
    };

    it('the move gets the file that landed, and a step after it reads where it went', async () => {
        const p = ports();
        const run = createFlowRunner({ ports: () => p, asleep: () => false });
        const result = await run(
            flow([fileTrigger(), move(), node('a', 'genie/agent_prompt', { agent: 'atlas@ws-example', prompt: 'moved {{in.from}} to {{in.to}}' }, 480)], [edge('t', 'm'), edge('m', 'a')]),
            { nodeId: 't', file },
        );
        expect(result).toEqual({ outcome: 'ran' });
        expect(p.calls[0]).toEqual(['move', WS.id, file.path, '.untracked']);
        expect(p.calls[1]).toEqual(['prompt', 'atlas@ws-example', `moved ${file.path} to ${join(WS.path, '.untracked', 'big.png')}`]);
    });

    it('a move the port refuses fails the run with the port\'s words', async () => {
        const p = ports({ moveFile: async () => { throw new Error('the folder ../x is outside the workspace; nothing was moved'); } });
        const run = createFlowRunner({ ports: () => p, asleep: () => false });
        const result = await run(flow([fileTrigger(), move()], [edge('t', 'm')]), { nodeId: 't', file });
        expect(result).toEqual({ outcome: 'failed', reason: expect.stringMatching(/outside the workspace; nothing was moved/), steps: [{ nodeId: 'm', label: 'moves the file into .untracked', outcome: 'failed' }] });
    });
});
