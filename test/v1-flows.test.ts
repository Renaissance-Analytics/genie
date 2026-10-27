import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flowNodes } from '../src/core/flow-form.js';
import { createFlowRunner } from '../src/main/flow-runner.js';
import { FlowStore } from '../src/main/flow-store.js';
import { runV1FlowImport } from '../src/main/v1-flows.js';
import { inOneTransaction, openFixtureDb } from './support/sqlite-fixture.js';

/**
 * GENIE 1's REAL FLOWS COME OVER (genie#1204). Genie 1's workflows lived in its `flows` table — one table since v74,
 * scope a column on it (main/flows/store.ts, main/db.ts v74 at v0.7.0-beta.342): an xyflow graph per row, born disarmed.
 * Earlier betas never imported them (the import skipped "tasks of type flow" and read nothing else). Now each workspace
 * flow comes over as a canvas flow, DISARMED, with its full graph: Genie 1's steps become the Genie 2 steps that do the same
 * thing, a template that named an upstream node reads the node's input, and what cannot come over is NOTED with why.
 *
 * The fixture's second row is the owner's own Genie 1 flow (its graph copied from his genie.db; ids kept, the workspace id
 * invented): a watcher that runs a script every 30 minutes and, on exit 10, wakes an agent with the script's output.
 */

const FLOWS = `CREATE TABLE flows (
                        id          TEXT PRIMARY KEY,
                        app_id      TEXT,
                        title       TEXT NOT NULL,
                        purpose     TEXT NOT NULL DEFAULT 'Automation',
                        description TEXT,
                        scope_json  TEXT NOT NULL,
                        graph_json  TEXT NOT NULL,
                        enabled     INTEGER NOT NULL DEFAULT 0,
                        created_at  TEXT NOT NULL,
                        updated_at  TEXT NOT NULL
                    )`;

const WS = { id: 'ws-example', path: '/w/example' };
const node = (id: string, kind: string, config: Record<string, unknown>, label?: string, x = 0, y = 0) => ({ id, type: kind, position: { x, y }, data: { kind, ...(label ? { label } : {}), config } });

const watcher = {
    nodes: [
        node('t0', '@particle-academy/manual_trigger', {}, 'Run by hand', 260, 0),
        node('t1', '@particle-academy/schedule_trigger', { cron: '*/30 * * * *', schedule: '*/30 * * * *' }, 'Every 30 minutes'),
        node('lane1', '@particle-academy/terminal_lane', {}, '[0L] watch', -40, 140),
        node('run1', '@particle-academy/terminal_run', { command: 'bash .ai/bin/learning-watch.sh', failOnNonZero: false }, 'Anything unreviewed?', 0, 200),
        node('br1', '@particle-academy/branch', { condition: '{{ run1.exitCode }} == 10' }, 'Exit 10 = yes', 0, 380),
        node('msg1', '@genie/agentinbox', { action: 'send', to: 'claude:moic', interrupt: true, text: '[0L] watch: there are learning reports nobody has reviewed.\n\n{{ run1.output }}\n\nRun /learning-review.' }, 'Wake the reviewer', 0, 540),
    ],
    edges: [{ id: 'e0', source: 't0', target: 'run1' }, { id: 'e1', source: 't1', target: 'run1' }, { id: 'e2', source: 'run1', target: 'br1' }, { id: 'e3', source: 'br1', target: 'msg1', sourceHandle: 'true' }],
};

const rows = [
    { id: 'flow-mtp9epmt-z9ae9g', app_id: null, title: 'New flow', scope: { kind: 'system' }, graph: { nodes: [node('start', '@particle-academy/manual_trigger', {})], edges: [] } },
    { id: 'flow-mun0imor-zxv9ob', app_id: null, title: '[0L] watch → Learning Review', scope: { kind: 'workspace', workspaceId: WS.id }, graph: watcher },
    { id: 'flow-gapp', app_id: 'app-1', title: 'app flow', scope: { kind: 'gapp', appId: 'app-1' }, graph: { nodes: [node('t', '@particle-academy/manual_trigger', {})], edges: [] } },
    { id: 'flow-site', app_id: null, title: 'set an env var', scope: { kind: 'workspace', workspaceId: WS.id }, graph: { nodes: [node('t', '@particle-academy/manual_trigger', {}), node('s', '@genie/setEnv', { key: 'APP_ENV', value: 'prod' })], edges: [{ id: 'e', source: 't', target: 's' }] } },
    { id: 'flow-elsewhere', app_id: null, title: 'elsewhere', scope: { kind: 'workspace', workspaceId: 'ws-not-in-genie2' }, graph: { nodes: [node('t', '@particle-academy/manual_trigger', {})], edges: [] } },
    { id: 'flow-files', app_id: null, title: 'new files', scope: { kind: 'workspace', workspaceId: WS.id }, graph: { nodes: [node('t', '@genie/event_trigger', { event: 'files:added' }), node('l', '@particle-academy/log', { message: 'a file: {{ t.relPath }}' })], edges: [{ id: 'e', source: 't', target: 'l' }] } },
];

function writeV1(file: string): void {
    const db = openFixtureDb(file);
    try {
        inOneTransaction(db, () => {
            db.exec(FLOWS);
            const ins = db.prepare('INSERT INTO flows (id, app_id, title, scope_json, graph_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            for (const r of rows) ins.run(r.id, r.app_id, r.title, JSON.stringify(r.scope), JSON.stringify(r.graph), 1, '2026-07-01T09:00:00.000Z', '2026-07-01T09:00:00.000Z');
        });
    } finally {
        db.close();
    }
}

let home: string;
let v1File: string;
const importInto = (store: FlowStore, database = v1File) => runV1FlowImport(store, { database, workspaces: [WS] });

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'genie2-v1-flows-')); v1File = join(home, 'v1-genie.db'); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("Genie 1's flows, imported once as DISARMED canvas flows", () => {
    it('the owner’s watcher comes over whole: both triggers, the command, the branch, and the agent it wakes — disarmed', async () => {
        writeV1(v1File);
        const store = await FlowStore.open(home);
        await importInto(store);
        const f = store.get('flow_v1f_flow-mun0imor-zxv9ob')!;
        expect(f).toMatchObject({ name: '[0L] watch → Learning Review', workspaceId: WS.id, armed: false, createdBy: { kind: 'user' } });
        expect(f.importedFrom).toBeUndefined();
        const byId = new Map(flowNodes(f.document).map((n) => [String(n.id), n]));
        expect([...byId.keys()]).toEqual(['t0', 't1', 'run1', 'br1', 'msg1']);
        expect(byId.get('t1')!.config).toEqual({ cron: '*/30 * * * *' });
        expect(byId.get('run1')).toMatchObject({ kind: 'genie/terminal_run', config: { workspace: WS.id, command: 'bash .ai/bin/learning-watch.sh', allowFailure: true } });
        expect(byId.get('br1')!.config).toEqual({ match: 'all', conditions: [{ left: '{{in.exitCode}}', operator: 'eq', right: '10' }] });
        expect(byId.get('msg1')).toMatchObject({ kind: 'genie/agent_prompt', config: { agent: 'claude:moic', prompt: expect.stringContaining('{{in.output}}') } });
        expect(store.schedules(f.id)).toEqual([{ nodeId: 't1', cron: '*/30 * * * *', timezone: undefined }]);
    });

    it('and it RUNS on Genie 2: exit 10 wakes the agent with the script’s output; any other exit does not', async () => {
        writeV1(v1File);
        const store = await FlowStore.open(home);
        await importInto(store);
        const prompts: Array<[string, string]> = [];
        let exit = 10;
        const run = createFlowRunner({ asleep: () => false, ports: () => ({ runCommand: async () => ({ exitCode: exit, output: 'reports: 3' }), promptAgent: async (a, t) => { prompts.push([a, t]); return 'on it'; }, addKnowledge: async () => ({ id: 'k' }) }) });
        expect(await run(store.get('flow_v1f_flow-mun0imor-zxv9ob')!, { nodeId: 't1', cron: '*/30 * * * *', timezone: undefined })).toEqual({ outcome: 'ran' });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]![0]).toBe('claude:moic');
        expect(prompts[0]![1]).toContain('reports: 3');
        exit = 0;
        await run(store.get('flow_v1f_flow-mun0imor-zxv9ob')!, { nodeId: 't1', cron: '*/30 * * * *', timezone: undefined });
        expect(prompts).toHaveLength(1);
    });

    it('a file trigger becomes "A file is added" in the flow’s workspace', async () => {
        writeV1(v1File);
        const store = await FlowStore.open(home);
        await importInto(store);
        const nodes = flowNodes(store.get('flow_v1f_flow-files')!.document);
        expect(nodes[0]).toMatchObject({ kind: 'genie/file_added', config: { workspace: WS.id } });
        expect(nodes[1]!.config).toMatchObject({ message: 'a file: {{in.relPath}}' });
    });

    it('NOTES what did not come over, each with why — a machine-wide flow, an app’s flow, a step Genie 2 has no counterpart for, a workspace not here', async () => {
        writeV1(v1File);
        const store = await FlowStore.open(home);
        const record = await importInto(store);
        expect(store.list().map((f) => f.id).sort()).toEqual(['flow_v1f_flow-files', 'flow_v1f_flow-mun0imor-zxv9ob']);
        const about = (title: string) => record.notes.filter((n) => n.includes(`"${title}"`));
        expect(about('New flow')).toEqual([expect.stringMatching(/machine-wide.*not imported/)]);
        expect(about('app flow')).toEqual([expect.stringMatching(/Genie App.*not imported/)]);
        // Genie 1's setEnv has no Genie 2 tool at all (a renamed tool is mapped: test/flow-tool-nodes.test.ts).
        expect(about('set an env var')).toEqual([expect.stringMatching(/node s: Genie 1's setEnv step has no counterpart in Genie 2's flows.*not imported/)]);
        expect(about('elsewhere')).toEqual([expect.stringMatching(/ws-not-in-genie2 is not in Genie 2.*not imported/)]);
        expect(record).toMatchObject({ sawV1: true, imported: 2 });
    });

    it('once: a second boot imports nothing, so what the person changed or removed stays; a boot that cannot see v1 is provisional', async () => {
        const blind = await FlowStore.open(home);
        expect(await importInto(blind, join(home, 'none.db'))).toMatchObject({ sawV1: false });
        writeV1(v1File);
        const store = await FlowStore.open(home);
        await importInto(store);
        await store.remove('flow_v1f_flow-files');
        const again = await FlowStore.open(home);
        await importInto(again);
        expect(again.list().map((f) => f.id)).toEqual(['flow_v1f_flow-mun0imor-zxv9ob']);
    });

    it("reads v1's database without changing a byte of it", async () => {
        writeV1(v1File);
        const before = createHash('md5').update(readFileSync(v1File)).digest('hex');
        await importInto(await FlowStore.open(home));
        expect(createHash('md5').update(readFileSync(v1File)).digest('hex')).toBe(before);
    });
});
