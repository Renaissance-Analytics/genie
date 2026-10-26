import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getNodeKind, listNodeKinds } from '@particle-academy/fancy-flow/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSupportedKind, paletteKindFilter } from '../src/core/flow-canvas.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { IssueWatchSummary } from '../src/core/issue-watch.js';
import { HUMAN } from '../src/core/inbox.js';
import type { AgentRecord } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { FlowCallers, FLOW_TOOLS, createFlowToolCaller, ensureFlowToolKinds, flowToolDefinitions } from '../src/main/flow-tools.js';
import { createFlowRunner } from '../src/main/flow-runner.js';
import type { FlowRecord } from '../src/main/flow-store.js';
import { genieToolDeps } from '../src/main/genie-tool-deps.js';
import { allGenieTools } from '../src/main/mcp-registrations.js';
import { ProcessBook } from '../src/main/process-book.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * GENIE'S TOOLS AS FLOW STEPS (genie#1204). Genie 1 offered every Genie tool a Genie App could be granted as a canvas node
 * `@genie/<tool>` (main/flows/nodes.ts:1-80, derived from the capability catalogue main/apps/capabilities.ts:40-135), its
 * config panel built from the tool's own MCP input schema with `terminalId` never authorable (main/flows/kinds.ts:120-170),
 * and ran each one through the SAME tool call an agent makes, as the flow (main/flows/executors.ts "THE DOOR",
 * main/flows/dispatch-call.ts). Genie 2 does the same with its own tools: each step calls the tool's real handler, as the
 * flow — in the flow's workspace, by the flow's name — so every authority and approval rule is the one an agent meets: a
 * step that needs the person's approval HOLDS the run and asks on the Deck; a denial fails the step with the tool's words.
 *
 * Each offered tool runs here for real and its EFFECT is checked. A tool that cannot act for a flow (an agent's own
 * thumbsUp, plan, the default agent's createAgent and tabs) is not offered.
 */

const pty: PtyPort = {
    open: (o) => ({ id: `term_${o.command ?? 'sh'}`, pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};
const docker: DockerRunner = async () => ({ stdout: '', exitCode: 1 });

let dir: string;
let services: ComposedServices;
let book: ProcessBook;
let wsPath: string;
const opened: Array<{ workspaceId: string; path: string }> = [];
const terminals: Array<{ workspaceId: string; command?: string | undefined }> = [];
let issues: IssueWatchSummary;
const roster = [{ id: 'agent_atlas', workspaceId: 'example', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null }] as unknown as AgentRecord[];
let callers: FlowCallers;
let call: ReturnType<typeof createFlowToolCaller>;

const flowOf = (nodes: unknown[], edges: unknown[], name = 'nightly'): FlowRecord => ({
    id: `flow_${name}`, workspaceId: 'example', name, armed: true,
    document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } },
    createdBy: { kind: 'user' }, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', refusals: [], runs: [],
});
const n = (id: string, kind: string, config: Record<string, unknown> = {}, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const e = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const step = (tool: string, config: Record<string, unknown>) => flowOf([n('t', 'manual_trigger'), n('s', `@genie/${tool}`, config, 240)], [e('t', 's')]);
const run = (flow: FlowRecord) => createFlowRunner({ asleep: () => false, ports: (f) => ({ runCommand: async () => ({ exitCode: 0, output: '' }), promptAgent: async () => '', addKnowledge: async () => ({ id: 'k' }), callTool: (tool, args) => call(f, tool, args) }) })(flow, null);

/** The approval the run is waiting on, once it has asked. */
async function asked(): Promise<{ id: string; title: string }> {
    for (let i = 0; i < 400 && services.approvals.deckItems().length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    const [item] = services.approvals.deckItems();
    expect(item).toBeDefined();
    return { id: item!.id, title: item!.title };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-tool-nodes-'));
    wsPath = join(dir, 'example');
    await mkdir(join(wsPath, 'docs'), { recursive: true });
    opened.length = 0;
    terminals.length = 0;
    issues = { state: 'live', linked: true, entry: { projectId: 'p', items: [], feedback: [] } };
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker, portFree: async () => true, roster: () => roster, workspaces: () => [{ id: 'example', path: wsPath }] });
    book = await ProcessBook.open(dir, { supervisor: services.supervisor, envFor: () => ({}), asleep: () => false });
    callers = new FlowCallers((id) => (id === 'example' ? wsPath : null));
    const never = (() => { throw new Error('not exercised'); }) as never;
    const registrations = allGenieTools(genieToolDeps({
        inbox: services.inbox, attention: services.attention, knowledge: services.knowledge, settings: services.settings,
        approve: (c, a, d) => services.approvals.gate(c, a, d),
        roster: () => roster, resolveCaller: (id) => callers.callerFor(id),
        userActive: () => true, glow: () => false, thumbsUp: () => {},
        openFile: async (t) => { opened.push({ workspaceId: t.workspaceId, path: t.path }); return { ok: true }; },
        terminals: { list: () => [], open: (o) => { terminals.push({ workspaceId: o.workspaceId, command: o.command }); return { id: 'term_1', pid: 2, shell: 'sh', scrollback: '' }; }, write: () => true, scrollback: () => '', scrollbackCap: 1000 },
        hosting: services,
        processes: { book, logs: () => null },
        issueWatch: { forWorkspace: () => issues },
        plugins: { tools: () => [], guard: () => null, run: never },
    }));
    call = createFlowToolCaller({ registrations, callers });
    ensureFlowToolKinds();
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('which of Genie’s tools are steps', () => {
    it('offers Genie 1’s tools that Genie 2 has, each as @genie/<tool> with its own schema and no terminalId — and nothing an agent alone can use', () => {
        expect([...FLOW_TOOLS].sort()).toEqual(['ForceTheQuestion', 'agentinbox', 'checkIssues', 'imDone', 'knowledge', 'manageTerminals', 'openFileForUser', 'processes', 'services', 'sites'].sort());
        const defs = flowToolDefinitions();
        expect(defs.map((d) => d.name).sort()).toEqual(FLOW_TOOLS.map((t) => `@genie/${t}`).sort());
        for (const d of defs) {
            expect(getNodeKind(d.name)?.name).toBe(d.name);
            expect(isSupportedKind(d.name)).toBe(true);
            expect(paletteKindFilter({ kind: d })).toBe(true);
            expect((d.configSchema ?? []).map((f) => f.key)).not.toContain('terminalId');
        }
        const offered = new Set(listNodeKinds().filter((kind) => paletteKindFilter({ kind })).map((k) => k.name));
        for (const agentOnly of ['thumbsUp', 'plan', 'createAgent', 'workspaceTabs', 'pages', 'flows', 'lists']) expect(offered.has(`@genie/${agentOnly}`)).toBe(false);
        // The panel is the tool's schema: an enum is a choice, a boolean a switch.
        const knowledge = defs.find((d) => d.name === '@genie/knowledge')!;
        expect(knowledge.configSchema!.find((f) => f.key === 'action')).toMatchObject({ type: 'select', required: true });
        expect(defs.find((d) => d.name === '@genie/checkIssues')!.outputs).toEqual([{ id: 'found' }, { id: 'none' }]);
        expect(defs.find((d) => d.name === '@genie/imDone')!.outputs).toEqual([]);
    });
});

describe('each step runs as the flow, through the tool’s own rules', () => {
    it('knowledge: adds a memory to the flow’s workspace', async () => {
        expect(await run(step('knowledge', { action: 'add', title: 'Nightly report', body: 'all green' }))).toEqual({ outcome: 'ran' });
        const node = services.knowledge.list({ scopes: [{ kind: 'workspace', id: 'example' }], limit: 10 }).nodes.find((k) => k.title === 'Nightly report');
        expect(node?.body).toBe('all green');
    });

    it('manageTerminals: HOLDS the run and asks the person, naming the flow; allowed, the terminal opens in the workspace', async () => {
        const going = run(step('manageTerminals', { action: 'create', command: 'npm run report' }));
        const q = await asked();
        expect(q.title).toMatch(/flow "nightly"/);
        expect(terminals).toEqual([]);
        services.approvals.resolve(q.id, 'allow');
        expect(await going).toEqual({ outcome: 'ran' });
        expect(terminals).toEqual([{ workspaceId: 'example', command: 'npm run report' }]);
    });

    it('manageTerminals denied: nothing opens, and the step fails with the tool’s words', async () => {
        const going = run(step('manageTerminals', { action: 'create', command: 'rm -rf build' }));
        services.approvals.resolve((await asked()).id, 'deny');
        expect(await going).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/denied/) });
        expect(terminals).toEqual([]);
    });

    it('processes: adding one asks the person; allowed, the workspace keeps it', async () => {
        const going = run(step('processes', { action: 'add', name: 'queue', command: 'php artisan queue:work' }));
        services.approvals.resolve((await asked()).id, 'allow');
        expect(await going).toEqual({ outcome: 'ran' });
        expect(book.kept().map((p) => [p.name, p.workspaceId])).toEqual([['queue', 'example']]);
    });

    it('sites: adds a site for a server already running, in the workspace', async () => {
        await mkdir(join(wsPath, 'app'), { recursive: true });
        // A site is kept in the workspace's envelope (the tool refuses a workspace without one, for a flow as for an agent).
        await writeFile(join(wsPath, 'project.json'), JSON.stringify({ name: 'example' }));
        expect(await run(step('sites',{ action: 'add', name: 'docs-app', repoPath: 'app', mode: 'proxy', hostPort: 4100 }))).toEqual({ outcome: 'ran' });
        expect(services.sites.list('example').map((s) => s.host)).toEqual(['docs-app.gen']);
    });

    it('services: reads the catalogue of engines it can run', async () => {
        const flow = flowOf([n('t', 'manual_trigger'), n('s', '@genie/services', { action: 'catalog' }, 240), n('k', 'genie/knowledge_add', { workspace: 'example', title: 'engines', body: '{{in.engines}}' }, 480)], [e('t', 's'), e('s', 'k')]);
        const written: string[] = [];
        const r = await createFlowRunner({ asleep: () => false, ports: (f) => ({ runCommand: async () => ({ exitCode: 0, output: '' }), promptAgent: async () => '', addKnowledge: async (k) => { written.push(k.body); return { id: 'k' }; }, callTool: (tool, args) => call(f, tool, args) }) })(flow, null);
        expect(r).toEqual({ outcome: 'ran' });
        expect(written[0]).toMatch(/postgres/i);
    });

    it('checkIssues: routes to `found` when something is open, `none` when nothing is', async () => {
        const flow = flowOf([n('t', 'manual_trigger'), n('c', '@genie/checkIssues', {}, 240), n('f', 'genie/knowledge_add', { workspace: 'example', title: 'found' }, 480), n('z', 'genie/knowledge_add', { workspace: 'example', title: 'none' }, 480)], [e('t', 'c'), e('c', 'f', 'found'), e('c', 'z', 'none')]);
        const written: string[] = [];
        const runner = createFlowRunner({ asleep: () => false, ports: (f) => ({ runCommand: async () => ({ exitCode: 0, output: '' }), promptAgent: async () => '', addKnowledge: async (k) => { written.push(k.title); return { id: 'k' }; }, callTool: (tool, args) => call(f, tool, args) }) });
        await runner(flow, null);
        issues = { ...issues, entry: { projectId: 'p', feedback: [], items: [{ key: 'i1', kind: 'issue', number: 7, repo: 'o/r', title: 'broken', url: 'https://x', updatedAt: null, severity: null }] } };
        await runner(flow, null);
        expect(written).toEqual(['none', 'found']);
    });

    it('openFileForUser: opens a file of the workspace for the person', async () => {
        expect(await run(step('openFileForUser', { path: 'docs/report.md' }))).toEqual({ outcome: 'ran' });
        expect(opened).toEqual([{ workspaceId: 'example', path: 'docs/report.md' }]);
    });

    it('imDone: the person sees the flow finished, with its note', async () => {
        expect(await run(step('imDone', { handoff: 'report written' }))).toEqual({ outcome: 'ran' });
        expect(services.attention.finished().at(-1)).toMatchObject({ agentName: 'flow "nightly"', handoff: 'report written' });
    });

    it('agentinbox: a message to the person arrives from the flow; to an agent the flow may not reach, refused (an agent’s rule)', async () => {
        expect(await run(step('agentinbox', { action: 'send', to: 'human', text: 'the report is ready' }))).toEqual({ outcome: 'ran' });
        expect(services.inbox.involving(HUMAN).map((m) => m.text)).toContain('the report is ready');
        expect(await run(step('agentinbox', { action: 'send', to: 'atlas', text: 'hi' }))).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/not reachable/) });
    });

    it('a Genie 1 flow’s tool step: one Genie 2 has under the same name comes over as that step (no terminalId); one renamed in Genie 2 is noted, not guessed at', async () => {
        const { planV1FlowImport } = await import('../src/core/v1-flows.js');
        const node = (id: string, kind: string, config: Record<string, unknown>) => ({ id, type: kind, position: { x: 0, y: 0 }, data: { kind, config } });
        const graph = (stepNode: unknown) => JSON.stringify({ nodes: [node('t', '@particle-academy/manual_trigger', {}), stepNode], edges: [{ id: 'e', source: 't', target: 's' }] });
        const plan = planV1FlowImport([
            { id: 'f-k', appId: null, title: 'remember', scopeJson: JSON.stringify({ kind: 'workspace', workspaceId: 'example' }), graphJson: graph(node('s', '@genie/knowledge', { action: 'add', title: 'T', terminalId: 'x' })) },
            { id: 'f-s', appId: null, title: 'restart', scopeJson: JSON.stringify({ kind: 'workspace', workspaceId: 'example' }), graphJson: graph(node('s', '@genie/manageSite', { action: 'restart', site: 'docs' })) },
        ], { workspaces: [{ id: 'example' }] })!;
        const steps = (plan.flows.find((f) => f.v1Id === 'f-k')!.document.graph as { nodes: Array<{ kind: string; config: Record<string, unknown> }> }).nodes;
        expect(steps[1]).toMatchObject({ kind: '@genie/knowledge', config: { action: 'add', title: 'T' } });
        expect(steps[1]!.config).not.toHaveProperty('terminalId');
        expect(plan.notes).toEqual([expect.stringMatching(/"restart".*node s: Genie 1's manageSite step is `sites` in Genie 2, whose settings differ; it was not converted/)]);
    });

    it('ForceTheQuestion: puts the question to the person and goes on at once', async () => {
        const questions = [{ question: 'Ship the nightly build?', header: 'Ship', options: [{ label: 'Yes', description: 'ship it' }, { label: 'No', description: 'hold it' }], multiSelect: false }];
        expect(await run(step('ForceTheQuestion', { questions }))).toEqual({ outcome: 'ran' });
        expect(services.attention.pending().map((q) => q.agentName)).toEqual(['flow "nightly"']);
    });

    it('templates resolve into a tool step’s settings, from the step before it', async () => {
        const flow = flowOf([n('t', 'schedule_trigger', { cron: '0 3 * * *' }), n('s', '@genie/knowledge', { action: 'add', title: 'fired on {{in.cron}}' }, 240)], [e('t', 's')]);
        await createFlowRunner({ asleep: () => false, ports: (f) => ({ runCommand: async () => ({ exitCode: 0, output: '' }), promptAgent: async () => '', addKnowledge: async () => ({ id: 'k' }), callTool: (tool, args) => call(f, tool, args) }) })(flow, { nodeId: 't', cron: '0 3 * * *', timezone: undefined });
        expect(services.knowledge.list({ scopes: [{ kind: 'workspace', id: 'example' }], limit: 10 }).nodes.map((k) => k.title)).toContain('fired on 0 3 * * *');
    });
});
