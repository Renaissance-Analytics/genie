import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESUMABLE_KINDS, safeToRerun } from '../src/core/flow-canvas.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { createFlowRunner } from '../src/main/flow-runner.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore } from '../src/main/flow-store.js';

/**
 * A RUN GENIE QUIT IN THE MIDDLE OF RESUMES (genie#1204; the owner: "do it better than Genie 1"). Genie 1 neither resumed a
 * run nor recorded one a quit cut short. Genie 2 keeps the run in flight on disk as it goes — each step's outcome AND its
 * output — and at the next launch:
 * - if every step that was running is SAFE TO RUN AGAIN, the run resumes FROM THAT STEP: the steps already done are not
 *   run again (their outputs are handed on as they were — fancy-flow's `resumeOutputs`), the interrupted step runs again,
 *   and the rest follows; the run is recorded `resumed`;
 * - otherwise it is recorded STOPPED at that step, as before — a command, a prompt to an agent, a file move, a tool that
 *   writes may already have done its work, and doing it twice is not Genie's call.
 * Safe: the pure logic steps, the triggers, Wait, Log and Output, and the Genie tools Genie 1 itself classed as read-only
 * or idempotent (main/flows/kinds.ts:178-200 at v0.7.0-beta.342: checkIssues; knowledge), plus ForceTheQuestion, whose
 * ask rejoins the same pending question rather than asking twice.
 */

const n = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const e = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const doc = (nodes: unknown[], edges: unknown[]) => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } });

describe('which steps are safe to run again', () => {
    it('logic, triggers, Wait, Log, Output, checkIssues, knowledge and ForceTheQuestion are; a command, a prompt, a move, a writing tool are not', () => {
        for (const kind of ['branch', 'switch_case', 'merge', 'transform', 'variable', 'wait', 'log', 'output', 'manual_trigger', 'schedule_trigger', 'genie/file_added', '@genie/checkIssues', '@genie/knowledge', '@genie/ForceTheQuestion']) expect(safeToRerun(kind)).toBe(true);
        for (const kind of ['genie/terminal_run', 'genie/agent_prompt', 'genie/file_move', 'genie/knowledge_add', '@genie/processes', '@genie/sites', '@genie/manageTerminals', '@genie/agentinbox', '@genie/imDone']) expect(safeToRerun(kind)).toBe(false);
        expect(RESUMABLE_KINDS.length).toBeGreaterThan(0);
    });
});

describe('a run Genie quit under', () => {
    async function interrupted(nodes: unknown[], edges: unknown[], hangAt: 'sleep' | 'command') {
        const home = await mkdtemp(join(tmpdir(), 'genie2-resume-'));
        const store = await FlowStore.open(home);
        const flow = await store.create({ workspaceId: 'ws', name: 'deploy', by: { kind: 'user' }, document: doc(nodes, edges) });
        const commands: string[] = [];
        let reached!: () => void;
        const atHang = new Promise<void>((r) => { reached = r; });
        const ports: FlowPorts = {
            runCommand: async (_w, command) => { commands.push(command); if (hangAt === 'command' && command === 'npm run long') { reached(); return new Promise(() => {}); } return { exitCode: 0, output: `out of ${command}` }; },
            promptAgent: async () => '', addKnowledge: async () => ({ id: 'k' }),
            sleep: () => { reached(); return new Promise(() => {}); },
        };
        const first = new FlowScheduler({ store, now: Date.now, schedule: () => () => {}, run: createFlowRunner({ asleep: () => false, ports: () => ports }) });
        void first.runNow(flow.id);
        await atHang;
        await new Promise((r) => setTimeout(r, 50));
        return { home, flowId: flow.id, commands };
    }

    it('at a SAFE step (a Wait): the next launch resumes from it — the build is not run again, the wait and the deploy are', async () => {
        const { home, flowId, commands } = await interrupted([n('t', 'manual_trigger'), n('b', 'genie/terminal_run', { workspace: 'ws', command: 'npm run build' }, 200), n('w', 'wait', { mode: 'duration', duration: '1h' }, 400), n('d', 'genie/terminal_run', { workspace: 'ws', command: 'npm run deploy {{in.input.output}}' }, 600)], [e('t', 'b'), e('b', 'w'), e('w', 'd')], 'sleep');
        try {
            expect(commands).toEqual(['npm run build']);
            const store = await FlowStore.open(home);
            const again: string[] = [];
            const scheduler = new FlowScheduler({ store, now: Date.now, schedule: () => () => {}, run: createFlowRunner({ asleep: () => false, ports: () => ({ runCommand: async (_w, c) => { again.push(c); return { exitCode: 0, output: '' }; }, promptAgent: async () => '', addKnowledge: async () => ({ id: 'k' }), sleep: async () => {} }) }) });
            await scheduler.resumeInterrupted();
            await scheduler.settled();
            // The build's output was kept and handed on: the deploy sees it, and the build did not run again.
            expect(again).toEqual(['npm run deploy out of npm run build']);
            const run = store.get(flowId)!.runs.at(-1)!;
            expect(run).toMatchObject({ trigger: 'manual', outcome: 'ran', resumed: true, nodes: { t: 'ran', b: 'ran', w: 'ran', d: 'ran' } });
            expect(store.get(flowId)!.inFlight).toBeUndefined();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('at an UNSAFE step (a command): recorded STOPPED at it, and nothing runs again', async () => {
        const { home, flowId } = await interrupted([n('t', 'manual_trigger'), n('s', 'genie/terminal_run', { workspace: 'ws', command: 'npm run long' }, 200), n('k', 'log', { message: 'done' }, 400)], [e('t', 's'), e('s', 'k')], 'command');
        try {
            const store = await FlowStore.open(home);
            const again: string[] = [];
            const scheduler = new FlowScheduler({ store, now: Date.now, schedule: () => () => {}, run: createFlowRunner({ asleep: () => false, ports: () => ({ runCommand: async (_w, c) => { again.push(c); return { exitCode: 0, output: '' }; }, promptAgent: async () => '', addKnowledge: async () => ({ id: 'k' }) }) }) });
            await scheduler.resumeInterrupted();
            await scheduler.settled();
            expect(again).toEqual([]);
            expect(store.get(flowId)!.runs.at(-1)).toMatchObject({ outcome: 'stopped', nodes: { t: 'ran', s: 'stopped', k: 'not reached' }, reason: expect.stringMatching(/not safe to run again/) });
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});
