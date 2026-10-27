import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { viewerStatuses } from '../../src/core/flow-canvas.js';
import { flowNodes } from '../../src/core/flow-form.js';
import { inOneTransaction, openFixtureDb } from '../support/sqlite-fixture.js';
import { AGENT, canvasDocument, edge, FakeSessions, node, nodeCommand, question, runNow, runsOf, save, startGenie, trySave, useGenie, WS, type DocEdge, type DocNode, type Genie } from './harness.js';

/**
 * THE RUN'S LIFE AND WHAT IS KEPT: the per-node overlay the canvas draws, a quit in the middle of a run (resumed when the
 * step it reached is safe to run again, recorded stopped when it is not), the save's refusals — every kind of graph
 * Genie will not hold — the arm and disarm rules, and Genie 1's flows brought over at launch.
 */

const manual = node('t', '@particle-academy/manual_trigger');
const log = (id: string, message: string, x = 600) => node(id, '@particle-academy/log', { level: 'info', message }, x);

describe('the run overlay: each node’s outcome, as the canvas draws it', () => {
    const genie = useGenie();

    it('a run that FAILED: ran / failed / not reached, and a branch’s untaken port skipped — and the canvas statuses for each', async () => {
        const g = genie();
        const id = await save(g, 'overlay', [
            manual,
            node('b', '@particle-academy/branch', { match: 'all', conditions: [{ left: 'yes', operator: 'eq', right: 'yes' }] }, 200),
            node('c', 'genie/terminal_run', { workspace: WS, command: nodeCommand('process.exit(2)') }, 400),
            log('after', 'never'),
            log('other', 'not taken', 400),
        ], [edge('t', 'b'), edge('b', 'c', 'true'), edge('b', 'other', 'false'), edge('c', 'after')]);
        const run = await runNow(g, id);
        expect(run).toMatchObject({ outcome: 'failed', nodes: { t: 'ran', b: 'ran', c: 'failed', after: 'not reached', other: 'skipped' } });
        expect(run.steps).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'c', outcome: 'failed' }), expect.objectContaining({ nodeId: 'after', outcome: 'not reached' })]));
        expect(viewerStatuses(run.nodes!)).toEqual({ t: 'ok', b: 'ok', c: 'failed', after: 'pending', other: 'skipped' });
    });

    it('a run HELD back: the held step, and the canvas draws it as still running', async () => {
        const g = genie();
        const id = await save(g, 'held', [manual, node('p', 'genie/agent_prompt', { agent: AGENT, prompt: 'go' }, 300), log('l', 'after')], [edge('t', 'p'), edge('p', 'l')]);
        g.sessions.mode = 'busy';
        const run = await runNow(g, id);
        expect(run.nodes).toEqual({ t: 'ran', p: 'held', l: 'not reached' });
        expect(viewerStatuses(run.nodes!)).toEqual({ t: 'ok', p: 'running', l: 'pending' });
    });

    it('while it runs, the overlay is kept on disk as it goes (the step it is on: running)', async () => {
        const g = genie();
        const id = await save(g, 'slow', [manual, node('w', '@particle-academy/wait', { mode: 'duration', duration: '1s' }, 300), log('l', 'done')], [edge('t', 'w'), edge('w', 'l')]);
        const going = runNow(g, id);
        await new Promise((r) => setTimeout(r, 300));
        expect(g.services.flows.get(id)!.inFlight).toMatchObject({ trigger: 'manual', nodes: { t: 'ran', w: 'running', l: 'not reached' } });
        const onDisk = JSON.parse(readFileSync(join(g.userData, 'runtime', 'flows.json'), 'utf8')) as { flows: Array<{ id: string; inFlight?: unknown }> };
        expect(onDisk.flows.find((f) => f.id === id)?.inFlight).toBeDefined();
        expect(await going).toMatchObject({ outcome: 'ran', nodes: { w: 'ran', l: 'ran' } });
        expect(g.services.flows.get(id)!.inFlight).toBeUndefined();
    });
});

describe('Genie quits in the middle of a run', () => {
    async function twoLaunches(test: (dir: string) => Promise<void>): Promise<void> {
        const dir = await mkdtemp(join(tmpdir(), 'genie-flows-quit-'));
        try { await test(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    }

    it('at a SAFE step (a question waiting): the next launch RESUMES from it — the command before it is not run again, the person is asked once', async () => {
        await twoLaunches(async (dir) => {
            const first = await startGenie({}, dir);
            const questions = [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }];
            const id = await save(first, 'ship', [
                manual,
                node('c', 'genie/terminal_run', { workspace: WS, command: nodeCommand("require('fs').appendFileSync('built.txt','x')") }, 200),
                node('q', '@genie/ForceTheQuestion', { questions }, 400),
                node('k', 'genie/knowledge_add', { workspace: WS, title: 'shipped', body: '{{ in.note }}' }, 600),
            ], [edge('t', 'c'), edge('c', 'q'), edge('q', 'k', 'Yes')]);
            void runNow(first, id).catch(() => {});
            await question(first);
            expect(readFileSync(join(first.ws, 'built.txt'), 'utf8')).toBe('x');
            await first.shutdown();

            const again = await startGenie({}, dir);
            try {
                const qid = await question(again);
                expect(again.services.attention.pending()).toHaveLength(1);
                await again.services.attention.answer(qid, { selections: [['Yes']], notes: ['go'], note: '' });
                const [run] = await runsOf(again, id, 1);
                expect(run).toMatchObject({ trigger: 'manual', outcome: 'ran', resumed: true, nodes: { t: 'ran', c: 'ran', q: 'ran', k: 'ran' } });
                expect(readFileSync(join(again.ws, 'built.txt'), 'utf8')).toBe('x');
                expect(again.services.knowledge.list({ scopes: [{ kind: 'workspace', id: WS }], limit: 10 }).nodes.map((k) => [k.title, k.body])).toContainEqual(['shipped', 'go']);
                expect(again.services.flows.get(id)!.inFlight).toBeUndefined();
            } finally {
                await again.shutdown();
            }
        });
    });

    it('at an UNSAFE step (a prompt to an agent whose turn never ended): recorded STOPPED at it, and the agent is not prompted again', async () => {
        await twoLaunches(async (dir) => {
            const sessions = new FakeSessions(['agent_atlas']);
            sessions.mode = 'never-ends';
            const first = await startGenie({ sessions }, dir);
            const id = await save(first, 'standup', [manual, node('p', 'genie/agent_prompt', { agent: AGENT, prompt: 'post it' }, 300), log('l', 'after')], [edge('t', 'p'), edge('p', 'l')]);
            void runNow(first, id).catch(() => {});
            await expect.poll(() => sessions.prompts.length, { timeout: 10_000 }).toBe(1);
            await expect.poll(() => first.services.flows.get(id)!.inFlight?.nodes.p, { timeout: 10_000 }).toBe('running');
            await first.shutdown();

            const again = await startGenie({}, dir);
            try {
                const run = again.services.flows.get(id)!.runs.at(-1);
                expect(run).toMatchObject({ trigger: 'manual', outcome: 'stopped', reason: expect.stringMatching(/not safe to run again/), nodes: { t: 'ran', p: 'stopped', l: 'not reached' } });
                await new Promise((r) => setTimeout(r, 300));
                expect(again.sessions.prompts).toEqual([]);
                expect(again.services.flows.get(id)!.runs).toHaveLength(1);
            } finally {
                await again.shutdown();
            }
        });
    });
});

describe('the save refuses every kind of graph Genie will not hold — nothing stored, each problem on its node', () => {
    const genie = useGenie();
    const cmd = (id: string, config: Record<string, unknown>) => node(id, 'genie/terminal_run', { workspace: WS, ...config }, 300);
    const cases: Array<{ name: string; nodes: DocNode[]; edges: DocEdge[]; problem: { nodeId?: string; message: RegExp }; flowName?: string }> = [
        { name: 'no trigger', nodes: [log('l', 'x')], edges: [], problem: { message: /needs something to start it/ } },
        { name: 'no step after the trigger', nodes: [manual], edges: [], problem: { message: /at least one step/ } },
        { name: 'a kind Genie cannot run', nodes: [manual, node('w', '@particle-academy/webhook_out', { url: 'https://example.com' }, 300)], edges: [edge('t', 'w')], problem: { nodeId: 'w', message: /not a step Genie can run/ } },
        { name: 'a kind nobody registered', nodes: [manual, node('z', 'acme/teleport', {}, 300)], edges: [edge('t', 'z')], problem: { message: /teleport/ } },
        { name: 'a Wait until a time', nodes: [manual, node('w', '@particle-academy/wait', { mode: 'until' }, 300)], edges: [edge('t', 'w')], problem: { nodeId: 'w', message: /duration only/ } },
        { name: 'a Wait Genie cannot honour', nodes: [manual, node('w', '@particle-academy/wait', { mode: 'duration', duration: '2 days' }, 300)], edges: [edge('t', 'w')], problem: { nodeId: 'w', message: /is not one Genie can wait/ } },
        { name: 'a loop', nodes: [manual, node('a', '@particle-academy/transform', {}, 200), node('b', '@particle-academy/transform', {}, 400)], edges: [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')], problem: { message: /form a loop/ } },
        { name: 'a schedule Genie cannot evaluate', nodes: [node('t', '@particle-academy/schedule_trigger', { cron: 'every day' }), log('l', 'x')], edges: [edge('t', 'l')], problem: { nodeId: 't', message: /"every day" is not a schedule Genie can evaluate/ } },
        { name: 'a timezone Genie does not know', nodes: [node('t', '@particle-academy/schedule_trigger', { cron: '0 3 * * *', timezone: 'Mars/Olympus' }), log('l', 'x')], edges: [edge('t', 'l')], problem: { nodeId: 't', message: /Mars\/Olympus is not one Genie knows/ } },
        { name: 'a workspace Genie does not have', nodes: [manual, node('c', 'genie/terminal_run', { workspace: 'nowhere', command: 'ls' }, 300)], edges: [edge('t', 'c')], problem: { nodeId: 'c', message: /there is no workspace "nowhere"/ } },
        { name: 'an agent nobody answers to', nodes: [manual, node('p', 'genie/agent_prompt', { agent: 'ghost', prompt: 'hi' }, 300)], edges: [edge('t', 'p')], problem: { nodeId: 'p', message: /no agent answers to ghost/ } },
        { name: 'a required setting missing', nodes: [manual, cmd('c', {})], edges: [edge('t', 'c')], problem: { nodeId: 'c', message: /command/i } },
        { name: 'a required setting that is only spaces', nodes: [manual, cmd('c', { command: '   ' })], edges: [edge('t', 'c')], problem: { nodeId: 'c', message: /command: Command is required/ } },
        { name: 'a file flow templating into a command', nodes: [node('t', 'genie/file_added', { workspace: WS }), cmd('c', { command: 'convert {{in.path}}' })], edges: [edge('t', 'c')], problem: { nodeId: 'c', message: /cannot template values into a command/ } },
        { name: 'a connection to a node that is not there', nodes: [manual, log('l', 'x')], edges: [edge('t', 'l'), edge('t', 'ghost')], problem: { message: /ghost/ } },
        { name: 'no name', nodes: [manual, log('l', 'x')], edges: [edge('t', 'l')], problem: { message: /name the flow/ }, flowName: '   ' },
    ];

    for (const c of cases) {
        it(c.name, async () => {
            const g = genie();
            const saved = await trySave(g, c.flowName ?? c.name, c.nodes, c.edges);
            expect(saved.ok).toBe(false);
            const problems = (saved as { problems: Array<{ nodeId?: string; message: string }> }).problems;
            expect(problems).toContainEqual(c.problem.nodeId !== undefined ? { nodeId: c.problem.nodeId, message: expect.stringMatching(c.problem.message) } : expect.objectContaining({ message: expect.stringMatching(c.problem.message) }));
            expect(g.services.flows.list()).toEqual([]);
        });
    }

    it('CONTROL: the same save with the problem fixed is stored', async () => {
        const g = genie();
        expect(await trySave(g, 'fine', [manual, cmd('c', { command: 'ls' })], [edge('t', 'c')])).toMatchObject({ ok: true });
        expect(g.services.flows.list()).toHaveLength(1);
    });

    it('the store’s own door (the one agents’ `flows create` passes) refuses the same graphs', async () => {
        const g = genie();
        await expect(g.services.flows.create({ workspaceId: WS, name: 'hook', document: canvasDocument([manual, node('w', '@particle-academy/webhook_out', { url: 'https://example.com' }, 300)], [edge('t', 'w')]), by: { kind: 'agent', id: 'agent_atlas', name: 'atlas' } })).rejects.toThrow(/node w: .*not a step Genie can run/);
        await expect(g.services.flows.create({ workspaceId: WS, name: 'blank', document: canvasDocument([manual, cmd('c', { command: '  ' })], [edge('t', 'c')]), by: { kind: 'user' } })).rejects.toThrow(/Command is required/);
        expect(g.services.flows.list()).toEqual([]);
    });
});

describe('arming and disarming', () => {
    const genie = useGenie();
    const nightly = (command = 'npm run report', x = 300) => [node('t', '@particle-academy/schedule_trigger', { cron: '0 3 * * *' }), node('c', 'genie/terminal_run', { workspace: WS, command }, x)];
    const wire = [edge('t', 'c')];
    const agent = { kind: 'agent', id: 'agent_atlas', name: 'atlas' } as const;

    it('a save never arms; the person arms; an agent can create but never arm — its attempt is recorded on the flow; either may disarm', async () => {
        const g = genie();
        const id = await save(g, 'nightly', nightly(), wire);
        expect(g.services.flows.get(id)!.armed).toBe(false);
        const made = await g.services.flows.create({ workspaceId: WS, name: 'by atlas', document: canvasDocument(nightly(), wire), by: agent, armed: true });
        expect(made.armed).toBe(false);
        expect(await g.services.flows.arm(made.id, agent)).toMatchObject({ ok: false, reason: expect.stringMatching(/an agent can create a flow but never arm one/) });
        expect(g.services.flows.get(made.id)!.refusals).toContainEqual(expect.objectContaining({ by: 'atlas', action: 'arm' }));
        expect(g.services.flows.get(made.id)!.armed).toBe(false);
        expect(await g.services.flows.arm(made.id, { kind: 'user' })).toMatchObject({ ok: true });
        await g.services.flows.disarm(made.id, agent);
        expect(g.services.flows.get(made.id)!.armed).toBe(false);
        // Armed or not is what the scheduler plans by: only the armed flow is due.
        await g.services.flows.arm(id, { kind: 'user' });
        expect(g.services.flowScheduler.nextDue()?.flowId).toBe(id);
    });

    it('changing WHAT an armed flow does disarms it on save, and says so; moving a node or renaming it does not', async () => {
        const g = genie();
        const id = await save(g, 'nightly', nightly(), wire);
        await g.services.flows.arm(id, { kind: 'user' });
        expect(await trySave(g, 'nightly', nightly('npm run report', 700), wire, id)).toMatchObject({ ok: true, disarmed: false });
        expect(await trySave(g, 'nightly report', nightly('npm run report', 700), wire, id)).toMatchObject({ ok: true, disarmed: false });
        expect(g.services.flows.get(id)!.armed).toBe(true);
        expect(await trySave(g, 'nightly report', nightly('rm -rf build'), wire, id)).toMatchObject({ ok: true, disarmed: true });
        expect(g.services.flows.get(id)!.armed).toBe(false);
        expect(g.services.flowScheduler.nextDue()).toBeNull();
    });
});

describe('Genie 1’s flows, brought over at launch', () => {
    const v1Node = (id: string, kind: string, config: Record<string, unknown>, label?: string) => ({ id, type: kind, position: { x: 0, y: 0 }, data: { kind, ...(label ? { label } : {}), config } });
    const v1Rows = [
        {
            id: 'watch', title: 'watch → wake the reviewer',
            graph: {
                nodes: [
                    v1Node('t0', '@particle-academy/manual_trigger', {}),
                    v1Node('t1', '@particle-academy/schedule_trigger', { cron: '*/30 * * * *', schedule: '*/30 * * * *' }),
                    v1Node('lane1', '@particle-academy/terminal_lane', {}, 'lane'),
                    v1Node('run1', '@particle-academy/terminal_run', { command: nodeCommand("process.stdout.write('reports: 3');process.exit(10)"), failOnNonZero: false }),
                    v1Node('br1', '@particle-academy/branch', { condition: '{{ run1.exitCode }} == 10' }),
                    v1Node('msg1', '@genie/agentinbox', { action: 'send', to: AGENT, text: 'unreviewed: {{ run1.output }}' }),
                    v1Node('k1', '@genie/knowledge', { action: 'add', title: 'woke {{ msg1.agent }}', body: 'from Genie 1', terminalId: 'term-1' }),
                ],
                edges: [
                    { id: 'e0', source: 't0', target: 'run1' }, { id: 'e1', source: 't1', target: 'run1' }, { id: 'e2', source: 'run1', target: 'br1' },
                    { id: 'e3', source: 'br1', target: 'msg1', sourceHandle: 'true' }, { id: 'e4', source: 'msg1', target: 'k1' },
                ],
            },
        },
        {
            id: 'files', title: 'new files',
            graph: { nodes: [v1Node('t', '@genie/event_trigger', { event: 'files:added' }), v1Node('l', '@particle-academy/log', { message: 'a file: {{ t.relPath }}' })], edges: [{ id: 'e', source: 't', target: 'l' }] },
        },
        {
            id: 'tools', title: 'renamed tools',
            graph: {
                nodes: [
                    v1Node('t', '@particle-academy/manual_trigger', {}),
                    v1Node('p', '@genie/manageProcess', { action: 'create', label: 'queue', command: 'php artisan queue:work', repo: 'app', autostart: true, terminalId: 't' }),
                    v1Node('s', '@genie/manageSite', { action: 'create', name: 'web', repo: 'site', hostServe: { mode: 'static', root: 'dist', spa: true } }),
                    v1Node('v', '@genie/manageService', { action: 'add', engine: 'postgres', version: '16', dedicated: false }),
                ],
                edges: [{ id: 'a', source: 't', target: 'p' }, { id: 'b', source: 'p', target: 's' }, { id: 'c', source: 's', target: 'v' }],
            },
        },
    ];

    async function v1Database(dir: string): Promise<string> {
        await mkdir(dir, { recursive: true });
        const file = join(dir, 'v1-genie.db');
        const db = openFixtureDb(file);
        try {
            inOneTransaction(db, () => {
                db.exec(`CREATE TABLE flows (id TEXT PRIMARY KEY, app_id TEXT, title TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'Automation', description TEXT, scope_json TEXT NOT NULL, graph_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
                const ins = db.prepare('INSERT INTO flows (id, app_id, title, scope_json, graph_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
                for (const r of v1Rows) ins.run(r.id, null, r.title, JSON.stringify({ kind: 'workspace', workspaceId: WS }), JSON.stringify(r.graph), '2026-07-01T09:00:00.000Z', '2026-07-01T09:00:00.000Z');
            });
        } finally {
            db.close();
        }
        return file;
    }

    /** A Genie launched with Genie 1's database beside it, as main launches one on a machine that had Genie 1. */
    async function launchedOnV1(): Promise<Genie> {
        const dir = await mkdtemp(join(tmpdir(), 'genie-flows-v1-'));
        return startGenie({ v1Database: await v1Database(join(dir, 'v1')) }, dir);
    }

    it('each mappable step comes over as the Genie 2 step that does the same, every flow DISARMED; then each runs on Genie 2', async () => {
        const g = await launchedOnV1();
        try {
            const watch = g.services.flows.get('flow_v1f_watch')!;
            const files = g.services.flows.get('flow_v1f_files')!;
            const tools = g.services.flows.get('flow_v1f_tools')!;
            for (const f of [watch, files, tools]) expect(f).toMatchObject({ workspaceId: WS, armed: false });
            const kinds = (doc: unknown) => Object.fromEntries(flowNodes(doc).map((n) => [String(n.id), n.kind]));
            expect(kinds(watch.document)).toEqual({ t0: '@particle-academy/manual_trigger', t1: '@particle-academy/schedule_trigger', run1: 'genie/terminal_run', br1: '@particle-academy/branch', msg1: 'genie/agent_prompt', k1: '@genie/knowledge' });
            const byId = new Map(flowNodes(watch.document).map((n) => [String(n.id), n.config]));
            expect(byId.get('t1')).toEqual({ cron: '*/30 * * * *' });
            expect(byId.get('run1')).toMatchObject({ workspace: WS, allowFailure: true });
            expect(byId.get('br1')).toEqual({ match: 'all', conditions: [{ left: '{{in.exitCode}}', operator: 'eq', right: '10' }] });
            expect(byId.get('msg1')).toEqual({ agent: AGENT, prompt: 'unreviewed: {{in.output}}' });
            expect(byId.get('k1')).toEqual({ action: 'add', title: 'woke {{in.agent}}', body: 'from Genie 1' });
            expect(flowNodes(files.document)).toMatchObject([{ kind: 'genie/file_added', config: { workspace: WS } }, { config: { message: 'a file: {{in.relPath}}' } }]);
            expect(Object.fromEntries(flowNodes(tools.document).map((n) => [String(n.id), [n.kind, n.config]]))).toMatchObject({
                p: ['@genie/processes', { action: 'add', name: 'queue', command: 'php artisan queue:work', folder: 'repos/app' }],
                s: ['@genie/sites', { action: 'add', name: 'web', repoPath: 'repos/site', mode: 'static', root: 'dist', spa: true }],
                v: ['@genie/services', { action: 'add', engine: 'postgres', version: '16', scope: 'shared' }],
            });

            // The watcher, armed and run on Genie 2: exit 10 wakes the agent with the script's output, then remembers it.
            await g.services.flows.arm(watch.id, { kind: 'user' });
            const run = await runNow(g, watch.id);
            expect(run).toMatchObject({ outcome: 'ran', nodes: { run1: 'ran', br1: 'ran', msg1: 'ran', k1: 'ran' } });
            expect(g.sessions.prompts).toHaveLength(1);
            expect(g.sessions.prompts[0]!.text).toContain('reports: 3');
            expect(g.services.knowledge.list({ scopes: [{ kind: 'workspace', id: WS }], limit: 10 }).nodes.map((k) => k.title)).toContain(`woke ${AGENT}`);

            // The file flow, armed: a file that lands runs it, with the file.
            await g.services.flows.arm(files.id, { kind: 'user' });
            await new Promise((r) => setTimeout(r, 300));
            await writeFile(join(g.ws, 'dropped.txt'), 'x');
            const [fileRun] = await runsOf(g, files.id, 1);
            expect(fileRun).toMatchObject({ trigger: 'file', file: 'dropped.txt', outcome: 'ran', log: ['a file: dropped.txt'] });
        } finally {
            await g.shutdown();
            await rm(g.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    });
});
