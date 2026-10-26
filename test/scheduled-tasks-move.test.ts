import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { FlowStore } from '../src/main/flow-store.js';
import { runtimeDir } from '../src/main/paths.js';
import { ProcessBook } from '../src/main/process-book.js';
import { moveScheduledTasksOutOfFlows } from '../src/main/scheduled-tasks-move.js';

/**
 * GENIE 1's SCHEDULED TASKS LEAVE FLOWS (the owner, 2026-10-26: the nine rows on the Flows page "are NOT flows"). Earlier
 * betas imported each Genie 1 scheduled task as a flow — a schedule trigger and one step — so a scheduled command read as
 * a workflow. Once, on an install that has them, they MOVE to the background processes they were in Genie 1: a command
 * becomes a scheduled process in its folder, a prompt to an agent an agent-nudge task, each keeping its schedule and
 * whether the person had armed it. Nothing else in Flows is touched. The move is recorded by a MARKER in processes.json, so
 * it runs once; every step of it is also safe to repeat (same ids, upserted) should a boot stop half way.
 */

const WS = { id: 'ws-example', path: resolve(tmpdir(), 'genie2-move-ws') };
const n = (id: string, kind: string, config: Record<string, unknown>, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const doc = (nodes: unknown[], edges: unknown[]) => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } });
const imported = (step: unknown) => doc([n('t', 'schedule_trigger', { cron: '0 3 * * *' }), step], [{ id: 'e1', source: 't', target: 's' }]);

const supervisor = { start: () => { throw new Error('nothing is started by the move'); }, stop: () => true, forget: () => true, list: () => [] };
let home: string;

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'genie2-move-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

/** flows.json as an earlier beta left it: Genie 1's tasks imported as flows (`importedFrom`), one armed by the person. */
async function writeFlowsFile(flows: unknown[]): Promise<void> {
    await mkdir(runtimeDir(home), { recursive: true });
    await writeFile(join(runtimeDir(home), 'flows.json'), JSON.stringify({ flows, v1Import: { at: '2026-10-20T00:00:00.000Z', sawV1: true, imported: flows.length } }));
}
const v1Flow = (spec: string, name: string, document: unknown, armed: boolean) => ({ id: `flow_v1_${spec}`, workspaceId: WS.id, name, document, armed, createdBy: { kind: 'user' }, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', refusals: [], runs: [], importedFrom: { v1SpecId: spec } });

async function seed(): Promise<FlowStore> {
    await writeFlowsFile([
        v1Flow('s-report', 'nightly report', imported(n('s', 'genie/terminal_run', { workspace: WS.id, command: 'npm run report', cwd: 'repos/app' }, 240)), true),
        v1Flow('s-nudge', 'standup', imported(n('s', 'genie/agent_prompt', { agent: 'ws-example:claude:atlas', prompt: 'post the standup' }, 240)), false),
    ]);
    const flows = await FlowStore.open(home);
    // A real workflow, drawn by the person: it stays.
    await flows.create({ workspaceId: WS.id, name: 'tidy', by: { kind: 'user' }, document: doc([n('t', 'manual_trigger', {}), n('l', 'log', { message: 'x' }, 240)], [{ id: 'e', source: 't', target: 'l' }]) });
    return flows;
}

const openBook = () => ProcessBook.open(home, { supervisor, envFor: () => ({}), asleep: () => false });

describe('moving Genie 1’s scheduled tasks out of Flows', () => {
    it('each becomes a scheduled background process — command or agent nudge — keeping its schedule and whether it was armed; Flows keeps only the real workflow', async () => {
        const flows = await seed();
        const book = await openBook();
        const result = await moveScheduledTasksOutOfFlows(flows, book, (id) => (id === WS.id ? WS.path : null));
        expect(result.moved).toBe(2);
        expect(flows.list().map((f) => f.name)).toEqual(['tidy']);
        const byId = new Map(book.kept().map((p) => [p.id, p]));
        expect(byId.get('proc_v1_s-report')).toMatchObject({ workspaceId: WS.id, name: 'nightly report', command: 'npm run report', cwd: join(WS.path, 'repos/app'), wanted: true, schedule: { cron: '0 3 * * *', kind: 'command' } });
        expect(byId.get('proc_v1_s-nudge')).toMatchObject({ workspaceId: WS.id, name: 'standup', wanted: false, schedule: { cron: '0 3 * * *', kind: 'agent-nudge', prompt: 'post the standup', agent: 'ws-example:claude:atlas' } });
        const file = JSON.parse(readFileSync(join(runtimeDir(home), 'processes.json'), 'utf8')) as { scheduledTasksMoved?: { moved: number } };
        expect(file.scheduledTasksMoved).toMatchObject({ moved: 2 });
    });

    it('runs ONCE: the marker stops a second move, and nothing is duplicated', async () => {
        const flows = await seed();
        await moveScheduledTasksOutOfFlows(flows, await openBook(), () => WS.path);
        const again = await openBook();
        expect(await moveScheduledTasksOutOfFlows(await FlowStore.open(home), again, () => WS.path)).toEqual({ moved: 0, kept: [] });
        expect(again.kept()).toHaveLength(2);
    });

    it('a boot that stopped half way (processes written, flows not yet emptied) finishes without duplicates', async () => {
        const flows = await seed();
        const book = await openBook();
        // The first half only: a process is there, no marker, the flows still hold the tasks.
        await book.adoptScheduled([{ id: 'proc_v1_s-report', workspaceId: WS.id, name: 'nightly report', command: 'npm run report', cwd: join(WS.path, 'repos/app'), wanted: true, schedule: { cron: '0 3 * * *', kind: 'command' } }]);
        await moveScheduledTasksOutOfFlows(flows, book, () => WS.path);
        expect(book.kept().map((p) => p.id).sort()).toEqual(['proc_v1_s-nudge', 'proc_v1_s-report']);
        expect(flows.list().map((f) => f.name)).toEqual(['tidy']);
    });

    it('one the person has since drawn into a real workflow (more than a schedule and one step) STAYS in Flows, and is said so', async () => {
        await writeFlowsFile([v1Flow('s-grown', 'grown', doc([n('t', 'schedule_trigger', { cron: '0 3 * * *' }), n('s', 'genie/terminal_run', { workspace: WS.id, command: 'npm test' }, 240), n('k', 'genie/knowledge_add', { workspace: WS.id, title: 'T' }, 480)], [{ id: 'e1', source: 't', target: 's' }, { id: 'e2', source: 's', target: 'k' }]), false)]);
        const flows = await FlowStore.open(home);
        const result = await moveScheduledTasksOutOfFlows(flows, await openBook(), () => WS.path);
        expect(result).toEqual({ moved: 0, kept: [expect.stringMatching(/"grown" is a workflow now .* stays in Flows/)] });
        expect(flows.list().map((f) => f.id)).toEqual(['flow_v1_s-grown']);
        expect(existsSync(join(runtimeDir(home), 'processes.json'))).toBe(true);
    });
});
