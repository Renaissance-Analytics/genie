import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUMAN } from '../../src/core/inbox.js';
import { approval, edge, kindCase, node, nodeCommand, question, runNow, save, useGenie, WS, type DocEdge, type DocNode, type Genie } from './harness.js';

/**
 * ALL TEN GENIE TOOL NODES (`@genie/<tool>`, genie#1204), each in a flow saved from the canvas and run by the scheduler's
 * Run now: the step calls the tool's REAL handler — registered exactly as main.ts registers them — as the flow, in the
 * flow's workspace. Every effect is read where the tool puts it. The tools that need the person's approval HOLD the run
 * on the Deck until they answer; allowed, the effect happens; denied, nothing does and the step fails in the tool's words.
 */

const genie = useGenie();
const manual = node('t', '@particle-academy/manual_trigger');
const tool = (id: string, name: string, config: Record<string, unknown>, x = 300) => node(id, `@genie/${name}`, config, x);
const one = (g: Genie, name: string, step: DocNode, extra: DocNode[] = [], edges: DocEdge[] = []) => save(g, name, [manual, step, ...extra], [edge('t', step.id), ...edges]);
const memories = (g: Genie) => g.services.knowledge.list({ scopes: [{ kind: 'workspace', id: WS }], limit: 100 }).nodes;

describe('tools that act at once', () => {
    kindCase('@genie/knowledge', 'knowledge: the memory is added to the flow’s workspace', genie, async () => {
        const g = genie();
        const id = await one(g, 'nightly', tool('s', 'knowledge', { action: 'add', title: 'Nightly report', body: 'all green' }));
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', nodes: { s: 'ran' } });
        expect(memories(g).find((k) => k.title === 'Nightly report')?.body).toBe('all green');
    });

    kindCase('@genie/services', 'services: the catalogue of engines it can run, handed to the next step', genie, async () => {
        const g = genie();
        const id = await one(g, 'engines', tool('s', 'services', { action: 'catalog' }), [node('k', 'genie/knowledge_add', { workspace: WS, title: 'engines', body: '{{in.engines}}' }, 600)], [edge('s', 'k')]);
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', nodes: { s: 'ran', k: 'ran' } });
        expect(memories(g).find((k) => k.title === 'engines')?.body).toMatch(/postgres/i);
    });

    kindCase('@genie/sites', 'sites: a site is added for the workspace', genie, async () => {
        const g = genie();
        await mkdir(join(g.ws, 'repos', 'app'), { recursive: true });
        await writeFile(join(g.ws, 'project.json'), JSON.stringify({ name: WS }));
        const id = await one(g, 'site', tool('s', 'sites', { action: 'add', name: 'docs-app', repoPath: 'repos/app', mode: 'proxy', hostPort: 4100 }));
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', nodes: { s: 'ran' } });
        expect(g.services.sites.list(WS).map((s) => s.host)).toEqual(['docs-app.gen']);
    });

    kindCase('@genie/checkIssues', 'checkIssues: down `found` when something is open, down `none` when nothing is', genie, async () => {
        const g = genie();
        const id = await one(g, 'issues', tool('c', 'checkIssues', {}), [
            node('f', '@particle-academy/log', { level: 'info', message: 'found' }, 600),
            node('z', '@particle-academy/log', { level: 'info', message: 'none' }, 600, 120),
        ], [edge('c', 'f', 'found'), edge('c', 'z', 'none')]);
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', log: ['none'], nodes: { c: 'ran', f: 'skipped', z: 'ran' } });
        g.issues = { ...g.issues, entry: { projectId: 'p', feedback: [], items: [{ key: 'i1', kind: 'issue', number: 7, repo: 'o/r', title: 'broken', url: 'https://x', updatedAt: null, severity: null }] } } as never;
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', log: ['found'], nodes: { c: 'ran', f: 'ran', z: 'skipped' } });
    });

    kindCase('@genie/openFileForUser', 'openFileForUser: the file is opened for the person, in the flow’s workspace', genie, async () => {
        const g = genie();
        const id = await one(g, 'show', tool('s', 'openFileForUser', { path: 'docs/report.md' }));
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', nodes: { s: 'ran' } });
        expect(g.opened).toEqual([{ workspaceId: WS, path: 'docs/report.md' }]);
    });

    kindCase('@genie/imDone', 'imDone: the person sees the flow finished, by name, with its handoff', genie, async () => {
        const g = genie();
        const id = await one(g, 'nightly', tool('s', 'imDone', { handoff: 'report written' }));
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', nodes: { s: 'ran' } });
        expect(g.services.attention.finished().at(-1)).toMatchObject({ agentName: 'flow "nightly"', handoff: 'report written' });
    });

    kindCase('@genie/agentinbox', 'agentinbox: a message to the PERSON and one to an AGENT are both delivered, from the flow', genie, async () => {
        const g = genie();
        const toPerson = await one(g, 'nightly', tool('s', 'agentinbox', { action: 'send', to: 'human', text: 'the report is ready' }));
        expect(await runNow(g, toPerson)).toMatchObject({ outcome: 'ran', nodes: { s: 'ran' } });
        expect(g.services.inbox.involving(HUMAN).map((m) => m.text)).toContain('flow "nightly": the report is ready');
        const toAgent = await one(g, 'handoff', tool('s', 'agentinbox', { action: 'send', to: 'atlas', text: 'review it' }));
        expect(await runNow(g, toAgent)).toMatchObject({ outcome: 'ran', nodes: { s: 'ran' } });
        const mail = g.services.inbox.involving('agent_atlas' as never).filter((m) => m.to === 'agent_atlas');
        expect(mail).toEqual([expect.objectContaining({ from: toAgent, text: 'flow "handoff": review it' })]);
    });
});

describe('approvals: a step that needs the person holds the run', () => {
    kindCase('@genie/manageTerminals', 'manageTerminals: HOLDS the run on the Deck, naming the flow; allowed, the terminal opens in the workspace', genie, async () => {
        const g = genie();
        const id = await one(g, 'nightly', tool('s', 'manageTerminals', { action: 'create', command: 'npm run report' }), [node('l', '@particle-academy/log', { level: 'info', message: 'opened' }, 600)], [edge('s', 'l')]);
        const going = runNow(g, id);
        const asked = await approval(g);
        expect(asked.title).toMatch(/flow "nightly"/);
        // Held: in flight, the step running, nothing opened yet, the run not recorded.
        expect(g.services.flowScheduler.inFlightCount()).toBe(1);
        expect(g.services.flows.get(id)!.inFlight?.nodes).toMatchObject({ s: 'running', l: 'not reached' });
        expect(g.terminals).toEqual([]);
        expect(g.services.flows.get(id)!.runs).toEqual([]);
        g.services.approvals.resolve(asked.id, 'allow');
        expect(await going).toMatchObject({ outcome: 'ran', nodes: { s: 'ran', l: 'ran' }, log: ['opened'] });
        expect(g.terminals).toEqual([{ workspaceId: WS, command: 'npm run report' }]);
    });

    it('manageTerminals DENIED: nothing opens, the step fails in the tool’s words, what follows is not reached', async () => {
        const g = genie();
        const id = await one(g, 'nightly', tool('s', 'manageTerminals', { action: 'create', command: 'rm -rf build' }), [node('l', '@particle-academy/log', { level: 'info', message: 'opened' }, 600)], [edge('s', 'l')]);
        const going = runNow(g, id);
        g.services.approvals.resolve((await approval(g)).id, 'deny');
        expect(await going).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/denied/), nodes: { s: 'failed', l: 'not reached' } });
        expect(g.terminals).toEqual([]);
    });

    kindCase('@genie/processes', 'processes: adding one asks the person; allowed, the workspace keeps it and it runs', genie, async () => {
        const g = genie();
        const id = await one(g, 'worker', tool('s', 'processes', { action: 'add', name: 'queue', command: nodeCommand('setTimeout(function(){},2000)') }));
        const going = runNow(g, id);
        g.services.approvals.resolve((await approval(g)).id, 'allow');
        expect(await going).toMatchObject({ outcome: 'ran', nodes: { s: 'ran' } });
        expect(g.book.kept().map((p) => [p.name, p.workspaceId])).toEqual([['queue', WS]]);
        expect(g.pty.opened.some((o) => o.command?.includes('setTimeout'))).toBe(true);
    });

    it('processes DENIED: nothing is kept and nothing starts', async () => {
        const g = genie();
        const id = await one(g, 'worker', tool('s', 'processes', { action: 'add', name: 'queue', command: 'php artisan queue:work' }));
        const going = runNow(g, id);
        g.services.approvals.resolve((await approval(g)).id, 'deny');
        expect(await going).toMatchObject({ outcome: 'failed', nodes: { s: 'failed' } });
        expect(g.book.kept()).toEqual([]);
        expect(g.pty.opened.filter((o) => o.command?.includes('queue:work'))).toEqual([]);
    });
});

describe('ForceTheQuestion: the run WAITS for the person and goes down their answer', () => {
    const questions = [{ question: 'Ship the nightly build?', header: 'Ship', options: [{ label: 'Yes', description: 'ship it' }, { label: 'No', description: 'hold it' }], multiSelect: false }];
    const ask = (g: Genie, waitMinutes?: number) => save(g, 'ship?', [
        manual,
        tool('q', 'ForceTheQuestion', { questions, ...(waitMinutes !== undefined ? { waitMinutes } : {}) }),
        node('y', '@particle-academy/log', { level: 'info', message: 'yes: {{ $json.note }}' }, 600, 0),
        node('n', '@particle-academy/log', { level: 'info', message: 'no' }, 600, 100),
        node('o', '@particle-academy/log', { level: 'info', message: 'note only: {{ $json.note }}' }, 600, 200),
        node('d', '@particle-academy/log', { level: 'info', message: 'dismissed: {{ $json.outcome }}' }, 600, 300),
    ], [edge('t', 'q'), edge('q', 'y', 'Yes'), edge('q', 'n', 'No'), edge('q', 'o', 'none chosen'), edge('q', 'd', 'dismissed')]);

    kindCase('@genie/ForceTheQuestion', 'asked on the Deck; the run is HELD until the answer, then goes down the chosen option with the note', genie, async () => {
        const g = genie();
        const id = await ask(g);
        const going = runNow(g, id);
        const qid = await question(g);
        await new Promise((r) => setTimeout(r, 50));
        expect(g.services.flows.get(id)!.runs).toEqual([]);
        expect(g.services.attention.pending().map((q) => q.agentName)).toEqual(['flow "ship?"']);
        await g.services.attention.answer(qid, { selections: [['Yes']], notes: ['ship at 9'], note: '' });
        expect(await going).toMatchObject({ outcome: 'ran', log: ['yes: ship at 9'], nodes: { q: 'ran', y: 'ran', n: 'skipped', o: 'skipped', d: 'skipped' } });
    });

    it('the other option goes down its own port', async () => {
        const g = genie();
        const id = await ask(g);
        const going = runNow(g, id);
        await g.services.attention.answer(await question(g), { selections: [['No']], notes: [''], note: '' });
        expect(await going).toMatchObject({ log: ['no'], nodes: { n: 'ran', y: 'skipped' } });
    });

    it('a note with no option chosen goes down "none chosen", carrying the note', async () => {
        const g = genie();
        const id = await ask(g);
        const going = runNow(g, id);
        await g.services.attention.answer(await question(g), { selections: [[]], notes: ['not tonight'], note: '' });
        expect(await going).toMatchObject({ log: ['note only: not tonight'], nodes: { o: 'ran' } });
    });

    it('dismissed by the person: down "dismissed"', async () => {
        const g = genie();
        const id = await ask(g);
        const going = runNow(g, id);
        await g.services.attention.dismiss(await question(g));
        expect(await going).toMatchObject({ log: ['dismissed: dismissed'], nodes: { d: 'ran' } });
    });

    it('no answer in time: down "dismissed" as timed out, and the person is no longer asked', async () => {
        const g = genie();
        const id = await ask(g, 0.002);
        expect(await runNow(g, id)).toMatchObject({ outcome: 'ran', log: ['dismissed: timed out'], nodes: { d: 'ran' } });
        expect(g.services.attention.pending()).toEqual([]);
    });
});
