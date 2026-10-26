import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { HeldBack, createFlowRunner } from '../src/main/flow-runner.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore, type FlowRecord } from '../src/main/flow-store.js';
import { FlowsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * WHERE A RUN STOPPED (genie#1204 item 6 — Genie 1 drew the run and where it stopped). A failed run said why, but not
 * WHICH step: in a three-step flow "exit code 2" does not say whether the report, the knowledge write or the prompt
 * failed, or what never ran. Each run now records its steps in graph order — ran, failed, held back, or not reached —
 * and the run history says where it stopped.
 */

const WS = { id: 'ws-example', path: resolve(tmpdir(), 'genie2-run-steps-ws') };
const node = (id: string, kind: string, config: Record<string, unknown>, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const flowOf = (nodes: unknown[], edges: unknown[]): FlowRecord => ({
    id: 'flow_report', workspaceId: WS.id, name: 'nightly report', armed: true,
    document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } },
    createdBy: { kind: 'user' }, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', refusals: [], runs: [],
});
const threeSteps = flowOf(
    [
        node('t', 'schedule_trigger', { cron: '0 3 * * *' }),
        node('r', 'genie/terminal_run', { workspace: WS.id, command: 'npm run report' }, 240),
        node('k', 'genie/knowledge_add', { workspace: WS.id, title: 'Nightly report', body: '{{in.output}}' }, 480),
        node('a', 'genie/agent_prompt', { agent: 'atlas@ws-example', prompt: 'the report is in' }, 720),
    ],
    [edge('t', 'r'), edge('r', 'k'), edge('k', 'a')],
);
const schedule = { nodeId: 't', cron: '0 3 * * *', timezone: undefined };
const ports = (over: Partial<FlowPorts> = {}): FlowPorts => ({
    promptAgent: async () => 'ok',
    runCommand: async () => ({ exitCode: 0, output: 'report written\n' }),
    addKnowledge: async () => ({ id: 'kn_1' }),
    ...over,
});

describe('a run records its steps, in graph order', () => {
    // Only a run that STOPPED carries its steps: one that ran says so in one word, as before.
    it('CONTROL: every step ran — the run is "ran", with no step list', async () => {
        const run = createFlowRunner({ ports: () => ports(), asleep: () => false });
        expect(await run(threeSteps, schedule)).toEqual({ outcome: 'ran' });
    });

    it('a step that fails is named in words, and what came after it never ran', async () => {
        const run = createFlowRunner({ ports: () => ports({ runCommand: async () => ({ exitCode: 2, output: 'boom' }) }), asleep: () => false });
        const r = await run(threeSteps, schedule);
        expect(r).toEqual({
            outcome: 'failed',
            reason: 'npm run report ended with exit code 2',
            steps: [
                { nodeId: 'r', label: 'runs the command `npm run report`', outcome: 'failed' },
                { nodeId: 'k', label: 'adds knowledge "Nightly report"', outcome: 'not reached' },
                { nodeId: 'a', label: 'prompts atlas@ws-example', outcome: 'not reached' },
            ],
        });
    });

    it('a step held back is named as held, not failed', async () => {
        const run = createFlowRunner({ ports: () => ports({ promptAgent: async () => { throw new HeldBack('atlas is busy (mid-turn)'); } }), asleep: () => false });
        const r = await run(threeSteps, schedule);
        if (r.outcome === 'ran') throw new Error('the run was expected to be held');
        expect(r.outcome).toBe('held');
        expect(r.steps?.map((s) => [s.nodeId, s.outcome])).toEqual([['r', 'ran'], ['k', 'ran'], ['a', 'held']]);
    });
});

describe('the steps are kept with the run, and shown', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-run-steps-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('the scheduler records them on the run; the history says where it stopped and what never ran', async () => {
        const store = await FlowStore.open(dir);
        const made = await store.create({ workspaceId: WS.id, name: 'nightly report', document: threeSteps.document, by: { kind: 'user' } });
        const run = createFlowRunner({ ports: () => ports({ addKnowledge: async () => { throw new Error('the knowledge store is closed'); } }), asleep: () => false });
        const scheduler = new FlowScheduler({ store, now: Date.now, schedule: () => () => {}, run });

        await scheduler.runNow(made.id);

        const recorded = store.get(made.id)!.runs.at(-1)!;
        expect(recorded.steps?.map((s) => [s.nodeId, s.outcome])).toEqual([['r', 'ran'], ['k', 'failed'], ['a', 'not reached']]);

        const html = renderToStaticMarkup(<FlowsSurface data={{ ...EMPTY_FEATURES, flows: { flows: [store.get(made.id)!], adding: null } }} onAction={() => {}} onNavigate={() => {}} />);
        const history = html.slice(html.indexOf('data-flow-run-steps'));
        expect(history).toContain('Stopped at: adds knowledge &quot;Nightly report&quot;');
        expect(history).toContain('data-flow-step="ran"');
        expect(history).toContain('data-flow-step="failed"');
        expect(history).toContain('data-flow-step="not reached"');
    });

    it('CONTROL: a run that ran says nothing about stopping', async () => {
        const store = await FlowStore.open(dir);
        const made = await store.create({ workspaceId: WS.id, name: 'nightly report', document: threeSteps.document, by: { kind: 'user' } });
        const scheduler = new FlowScheduler({ store, now: Date.now, schedule: () => () => {}, run: createFlowRunner({ ports: () => ports(), asleep: () => false }) });
        await scheduler.runNow(made.id);
        const html = renderToStaticMarkup(<FlowsSurface data={{ ...EMPTY_FEATURES, flows: { flows: [store.get(made.id)!], adding: null } }} onAction={() => {}} onNavigate={() => {}} />);
        expect(html).not.toContain('Stopped at');
        expect(store.get(made.id)!.runs.at(-1)!.steps).toBeUndefined();
    });
});
