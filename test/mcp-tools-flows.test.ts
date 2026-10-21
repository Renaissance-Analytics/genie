import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { mintAgentId } from '../src/core/identity.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { createFlowRunner } from '../src/main/flow-runner.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore } from '../src/main/flow-store.js';
import { genieToolDeps } from '../src/main/genie-tool-deps.js';
import { allGenieTools } from '../src/main/mcp-registrations.js';
import { flowTools } from '../src/main/mcp-tools-flows.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';

/**
 * AGENTS MAKE FLOWS; THE PERSON ARMS THEM. The `flows` tool runs against the REAL flow store, the REAL scheduler and
 * the REAL runner (fancy-flow's engine with Genie's kinds); only the runner's ports — the command, the prompt, the
 * knowledge write — are counting fakes. Every refusal is checked for having done NOTHING, beside a control in the same
 * test that does something. Names are RFC 2606 / invented.
 */

const user = { kind: 'user' } as const;
let dir: string;
let store: FlowStore;
let scheduler: FlowScheduler;
let tools: Registration[];
let ports: FlowPorts & { calls: unknown[][]; exitCode: number };
const callers: Record<string, Caller> = {};

function countingPorts(): FlowPorts & { calls: unknown[][]; exitCode: number } {
    const p = {
        calls: [] as unknown[][],
        exitCode: 0,
        promptAgent: async (address: string, text: string) => { p.calls.push(['prompt', address, text]); return 'on it'; },
        runCommand: async (workspaceId: string, command: string, cwd: string | undefined) => { p.calls.push(['run', workspaceId, command, cwd]); return { exitCode: p.exitCode, output: `exit ${p.exitCode}\n` }; },
        addKnowledge: async (input: unknown) => { p.calls.push(['knowledge', input]); return { id: 'kn_1' }; },
    };
    return p;
}

async function call(terminalId: string, args: JsonObject, set: Registration[] = tools) {
    const reg = set.find((t) => t.definition.name === 'flows')!;
    const r = await reg.handler({ ...args, terminalId }, { server: 'genie', tool: 'flows', headers: {} });
    return { ...r, json: JSON.parse(r.text) as Record<string, any> };
}

const node = (id: string, kind: string, config: Record<string, unknown>, x = 0) => ({ id, kind, position: { x, y: 0 }, config });
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
// A JsonObject because it is what an agent's call carries; the store takes it as the `unknown` it validates.
const doc = (nodes: unknown[], edges: unknown[]): JsonObject => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } }) as unknown as JsonObject;
/** A schedule feeding one command in `workspace`. */
const commandDoc = (workspace: string, command = 'npm run report') =>
    doc([node('t', 'schedule_trigger', { cron: '0 3 * * *', timezone: 'UTC' }), node('s', 'genie/terminal_run', { workspace, command }, 240)], [edge('t', 's')]);

/** THE WATCHER: every 30 minutes run a check; if it exits 10, tell an agent. */
const watcherDoc = (workspace: string) =>
    doc(
        [
            node('t', 'schedule_trigger', { cron: '*/30 * * * *', timezone: 'UTC' }),
            node('check', 'genie/terminal_run', { workspace, command: 'scripts/check-queue.sh', allowFailure: true }, 240),
            node('if10', 'branch', { match: 'all', conditions: [{ left: '{{in.exitCode}}', operator: 'eq', right: '10' }] }, 480),
            node('tell', 'genie/agent_prompt', { agent: 'claude:atlas', prompt: 'The queue check exited 10: {{in.output}}' }, 720),
        ],
        [edge('t', 'check'), edge('check', 'if10'), edge('if10', 'tell', 'true')],
    );

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-flows-'));
    store = await FlowStore.open(dir);
    ports = countingPorts();
    // The scheduler's timer never fires here: every run in these tests is a Run now.
    scheduler = new FlowScheduler({ store, now: Date.now, schedule: () => () => {}, run: createFlowRunner({ ports: () => ports, asleep: () => false }) });
    callers['t-atlas'] = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'example', workspacePath: join(dir, 'example') };
    callers['t-orion'] = { agentId: mintAgentId(), agentName: 'orion', workspaceId: 'example', workspacePath: join(dir, 'example') };
    callers['t-vega'] = { agentId: mintAgentId(), agentName: 'vega', workspaceId: 'example-other', workspacePath: join(dir, 'example-other') };
    tools = flowTools({ resolveCaller: (id) => callers[id] ?? null, flows: { store, runNow: (id) => scheduler.runNow(id) } });
});

afterEach(async () => {
    await scheduler.settled();
    await rm(dir, { recursive: true, force: true });
});

describe('flows create: in the caller’s workspace, by the agent, always DISARMED', () => {
    it('creates the flow as the agent, disarmed even when it asks for armed — counted', async () => {
        const r = await call('t-atlas', { action: 'create', name: 'nightly report', document: commandDoc('example'), armed: true });
        expect(r.isError).toBe(false);
        expect(r.json.flow).toMatchObject({ name: 'nightly report', armed: false });
        const [made, ...rest] = store.list();
        expect(rest).toEqual([]);
        expect(made).toMatchObject({ id: r.json.flow.id, workspaceId: 'example', armed: false, createdBy: { kind: 'agent', id: callers['t-atlas']!.agentId, name: 'atlas' } });
        expect(r.json.note).toMatch(/the person arms it/);
    });

    it('a document the engine refuses is refused in the ENGINE’s words, and nothing is created (control: a good one is)', async () => {
        const bad = doc([node('t', 'schedule_trigger', { cron: '0 3 * * *' }), node('s', 'genie/no_such_kind', {}, 240)], [edge('t', 's')]);
        const r = await call('t-atlas', { action: 'create', name: 'broken', document: bad });
        expect(r.isError).toBe(true);
        expect(r.json.error).toBe('the flow document was refused by the engine: node s: Unknown kind "genie/no_such_kind" — register it before importing.');
        expect(store.list()).toEqual([]);
        expect((await call('t-atlas', { action: 'create', name: 'good', document: commandDoc('example') })).isError).toBe(false);
        expect(store.list()).toHaveLength(1);
    });

    it('a step aimed at ANOTHER workspace is refused before anything is stored (control: its own workspace is accepted)', async () => {
        const r = await call('t-atlas', { action: 'create', name: 'elsewhere', document: commandDoc('example-other') });
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/node s .*workspace example-other.*only in its own workspace, example/);
        expect(store.list()).toEqual([]);
        expect((await call('t-atlas', { action: 'create', name: 'here', document: commandDoc('example') })).isError).toBe(false);
        expect(store.list()).toHaveLength(1);
    });

    it('create needs a name and a document; nothing is created without them', async () => {
        expect((await call('t-atlas', { action: 'create', document: commandDoc('example') })).isError).toBe(true);
        expect((await call('t-atlas', { action: 'create', name: 'x' })).isError).toBe(true);
        expect(store.list()).toEqual([]);
    });
});

describe('flows list and get: the caller’s own workspace only', () => {
    it('list: this workspace’s flows with id, armed, schedules and the last runs with outcomes — counted', async () => {
        const mine = await store.create({ workspaceId: 'example', name: 'nightly report', document: commandDoc('example'), by: user, armed: true });
        await store.create({ workspaceId: 'example-other', name: 'theirs', document: commandDoc('example-other'), by: user });
        for (let i = 0; i < 7; i++) await store.recordRun(mine.id, { trigger: 'schedule', outcome: i === 6 ? 'failed' : 'ran', ...(i === 6 ? { reason: 'npm run report ended with exit code 2' } : {}), startedAt: Date.UTC(2026, 9, 15, 3, i) });
        const r = await call('t-atlas', { action: 'list' });
        expect(r.isError).toBe(false);
        expect(r.json.flows).toHaveLength(1);
        const [f] = r.json.flows;
        expect(f).toMatchObject({ id: mine.id, name: 'nightly report', armed: true, schedules: [{ nodeId: 't', cron: '0 3 * * *', timezone: 'UTC' }] });
        expect(f.runs).toHaveLength(5);
        expect(f.runs.at(-1)).toMatchObject({ outcome: 'failed', reason: 'npm run report ended with exit code 2' });
        expect(f.runs[0].at).toBe(new Date(Date.UTC(2026, 9, 15, 3, 2)).toISOString());
        expect((await call('t-vega', { action: 'list' })).json.flows.map((x: any) => x.name)).toEqual(['theirs']);
    });

    it('get: the document, refusals and run history; another workspace’s flow answers exactly as a missing one', async () => {
        const mine = await store.create({ workspaceId: 'example', name: 'nightly report', document: commandDoc('example'), by: user });
        await store.arm(mine.id, { kind: 'agent', id: callers['t-atlas']!.agentId, name: 'atlas' });
        const r = await call('t-atlas', { action: 'get', id: mine.id });
        expect(r.isError).toBe(false);
        expect(r.json.flow).toMatchObject({ id: mine.id, document: { version: 1, graph: { nodes: [{ id: 't' }, { id: 's' }] } }, refusals: [{ by: 'atlas', action: 'arm' }], runs: [] });

        const theirs = await call('t-vega', { action: 'get', id: mine.id });
        const missing = await call('t-vega', { action: 'get', id: 'flow_nope' });
        expect(theirs.isError).toBe(true);
        expect(theirs.json.error).toBe(missing.json.error.replace('flow_nope', mine.id));
    });
});

describe('flows arm: the person’s, never an agent’s', () => {
    it('an agent’s arm is refused in the store’s words and recorded on the flow; it stays disarmed (control: the person’s arm arms it)', async () => {
        const made = (await call('t-atlas', { action: 'create', name: 'nightly report', document: commandDoc('example') })).json.flow;
        const r = await call('t-atlas', { action: 'arm', id: made.id });
        expect(r.isError).toBe(true);
        expect(r.json.error).toBe('an agent can create a flow but never arm one; ask the user to arm "nightly report"');
        expect(store.get(made.id)).toMatchObject({ armed: false, refusals: [{ by: 'atlas', action: 'arm' }] });
        expect((await store.arm(made.id, user)).ok).toBe(true);
        expect(store.get(made.id)!.armed).toBe(true);
    });

    it('disarm is open to the agent: it only ever makes less happen', async () => {
        const f = await store.create({ workspaceId: 'example', name: 'nightly report', document: commandDoc('example'), by: user, armed: true });
        const r = await call('t-atlas', { action: 'disarm', id: f.id });
        expect(r.isError).toBe(false);
        expect(r.json.flow).toMatchObject({ armed: false });
        expect(store.get(f.id)!.armed).toBe(false);
    });
});

describe('flows update', () => {
    it('renames and re-documents a DISARMED flow; an ARMED flow’s document is refused unchanged (control: after disarm it goes through)', async () => {
        const f = await store.create({ workspaceId: 'example', name: 'nightly report', document: commandDoc('example'), by: user, armed: true });
        const refused = await call('t-atlas', { action: 'update', id: f.id, document: commandDoc('example', 'rm -rf build') });
        expect(refused.isError).toBe(true);
        expect(refused.json.error).toMatch(/armed.*disarm it first/);
        expect(JSON.stringify(store.get(f.id)!.document)).not.toContain('rm -rf build');
        expect(store.get(f.id)!.armed).toBe(true);

        await call('t-atlas', { action: 'disarm', id: f.id });
        const r = await call('t-atlas', { action: 'update', id: f.id, name: 'nightly build', document: commandDoc('example', 'npm run build') });
        expect(r.isError).toBe(false);
        expect(store.get(f.id)).toMatchObject({ name: 'nightly build', armed: false });
        expect(JSON.stringify(store.get(f.id)!.document)).toContain('npm run build');
    });

    it('an update the engine refuses changes nothing and says so in the engine’s words', async () => {
        const f = await store.create({ workspaceId: 'example', name: 'nightly report', document: commandDoc('example'), by: user });
        const r = await call('t-atlas', { action: 'update', id: f.id, document: { version: 2 } });
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/^the flow document was refused by the engine: /);
        expect(store.get(f.id)!.document).toEqual(f.document);
    });
});

describe('flows runNow: only what the person armed', () => {
    it('a DISARMED flow is refused — nothing runs, nothing is recorded (control: once the person arms it, it runs once, recorded manual)', async () => {
        const made = (await call('t-atlas', { action: 'create', name: 'nightly report', document: commandDoc('example') })).json.flow;
        const refused = await call('t-atlas', { action: 'runNow', id: made.id });
        expect(refused.isError).toBe(true);
        expect(refused.json.error).toMatch(/not armed.*the person arms it/);
        await scheduler.settled();
        expect(ports.calls).toEqual([]);
        expect(store.get(made.id)!.runs).toEqual([]);

        await store.arm(made.id, user);
        const r = await call('t-atlas', { action: 'runNow', id: made.id });
        expect(r.isError).toBe(false);
        await scheduler.settled();
        expect(ports.calls).toEqual([['run', 'example', 'npm run report', undefined]]);
        expect(store.get(made.id)!.runs.map((x) => [x.trigger, x.outcome])).toEqual([['manual', 'ran']]);
    });
});

describe('flows remove: only a flow this agent created', () => {
    it('its own flow goes; the person’s and another agent’s stay (counted)', async () => {
        const own = (await call('t-atlas', { action: 'create', name: 'mine', document: commandDoc('example') })).json.flow;
        const orions = (await call('t-orion', { action: 'create', name: 'orion’s', document: commandDoc('example') })).json.flow;
        const persons = await store.create({ workspaceId: 'example', name: 'the person’s', document: commandDoc('example'), by: user });
        const refused = [await call('t-atlas', { action: 'remove', id: orions.id }), await call('t-atlas', { action: 'remove', id: persons.id })];
        expect(refused.filter((r) => r.isError && /only a flow it created/.test(r.json.error))).toHaveLength(2);
        expect(store.list()).toHaveLength(3);
        const r = await call('t-atlas', { action: 'remove', id: own.id });
        expect(r.json).toMatchObject({ ok: true, removed: own.id });
        expect(store.list().map((f) => f.id).sort()).toEqual([orions.id, persons.id].sort());
    });
});

describe('flows: never another workspace’s', () => {
    it('every action on another workspace’s flow is "not found", with NO side effect (control: its own agent’s disarm works)', async () => {
        const f = await store.create({ workspaceId: 'example', name: 'nightly report', document: commandDoc('example'), by: user, armed: true });
        const before = JSON.stringify(store.get(f.id));
        const refused = await Promise.all(['get', 'update', 'arm', 'disarm', 'runNow', 'remove'].map((action) => call('t-vega', { action, id: f.id, name: 'taken' })));
        expect(refused.filter((r) => r.isError && r.json.error === `no flow ${f.id} in this workspace; \`flows list\` shows them. Nothing was done`)).toHaveLength(6);
        await scheduler.settled();
        expect(JSON.stringify(store.get(f.id))).toBe(before);
        expect(ports.calls).toEqual([]);

        expect((await call('t-atlas', { action: 'disarm', id: f.id })).isError).toBe(false);
        expect(store.get(f.id)!.armed).toBe(false);
    });
});

describe('THE WATCHER, end to end: every 30 minutes run a check; if it exits 10, prompt an agent', () => {
    it('made by the agent, arming refused to it, armed by the person; exit 10 prompts the agent, exit 0 does not', async () => {
        const created = await call('t-atlas', { action: 'create', name: 'queue watcher', document: watcherDoc('example') });
        expect(created.isError).toBe(false);
        const id = created.json.flow.id as string;
        expect(created.json.flow.schedules).toEqual([{ nodeId: 't', cron: '*/30 * * * *', timezone: 'UTC' }]);

        const arm = await call('t-atlas', { action: 'arm', id });
        expect(arm.isError).toBe(true);
        expect(store.get(id)!.armed).toBe(false);
        expect((await store.arm(id, user)).ok).toBe(true);

        // Exit 10: the branch takes `true` and the agent is prompted with the check's output.
        ports.exitCode = 10;
        expect((await call('t-atlas', { action: 'runNow', id })).isError).toBe(false);
        await scheduler.settled();
        expect(ports.calls).toEqual([
            ['run', 'example', 'scripts/check-queue.sh', undefined],
            ['prompt', 'claude:atlas', 'The queue check exited 10: exit 10\n'],
        ]);

        // Exit 0: the same flow runs its check and the prompt is NOT sent.
        ports.calls.length = 0;
        ports.exitCode = 0;
        expect((await call('t-atlas', { action: 'runNow', id })).isError).toBe(false);
        await scheduler.settled();
        expect(ports.calls).toEqual([['run', 'example', 'scripts/check-queue.sh', undefined]]);

        expect(store.get(id)!.runs.map((r) => [r.trigger, r.outcome])).toEqual([['manual', 'ran'], ['manual', 'ran']]);
        const got = await call('t-atlas', { action: 'get', id });
        expect(got.json.flow.runs).toHaveLength(2);
    });
});

describe('flows: wiring', () => {
    it('nobody Genie knows is refused; a Genie with no flows (doctor) says so; the normal wiring reaches the store (control)', async () => {
        expect((await call('t-nobody', { action: 'list' })).json.error).toMatch(/not one Genie knows/);
        const none = flowTools({ resolveCaller: (id) => callers[id] ?? null, flows: null });
        expect((await call('t-atlas', { action: 'list' }, none)).json.error).toMatch(/keeps no flows/);

        await store.create({ workspaceId: 'example', name: 'nightly report', document: commandDoc('example'), by: user });
        const never = (() => { throw new Error('not exercised'); }) as never;
        const wired = allGenieTools(genieToolDeps({
            inbox: never, attention: never, knowledge: never, settings: never, approve: async () => 'denied', roster: () => [], resolveCaller: (id) => callers[id] ?? null,
            userActive: () => true, glow: () => false, thumbsUp: () => {}, openFile: never, terminals: never,
            flows: { store, runNow: (id) => scheduler.runNow(id) },
            plugins: { tools: () => [], guard: () => null, run: never },
        }));
        const r = await call('t-atlas', { action: 'list' }, wired);
        expect(r.isError).toBe(false);
        expect(r.json.flows.map((f: any) => f.name)).toEqual(['nightly report']);
    });

    it('is registered after processes, and the genie skill names it, saying the person arms what it makes', () => {
        const never = (() => { throw new Error('not exercised'); }) as never;
        const names = allGenieTools(genieToolDeps({
            inbox: never, attention: never, knowledge: never, settings: never, approve: async () => 'denied', roster: () => [], resolveCaller: () => null,
            userActive: () => true, glow: () => false, thumbsUp: () => {}, openFile: never, terminals: never,
            plugins: { tools: () => [], guard: () => null, run: never },
        })).map((r) => r.definition.name);
        expect(names.slice(names.indexOf('processes'), names.indexOf('processes') + 2)).toEqual(['processes', 'flows']);
        const genie = GENIE_SKILLS.find((s) => s.name === 'genie')!;
        expect(genie.body).toMatch(/^- `flows` for scheduled or repeating work.*the person arms it/m);
    });

    it('says plainly that the PERSON arms a flow, and carries a title', () => {
        const [t] = tools;
        expect(t!.definition.name).toBe('flows');
        expect(t!.definition.description).toMatch(/created DISARMED/);
        expect(t!.definition.description).toMatch(/the person arms it in Genie’s Flows/);
        expect(t!.definition.title).toBe('Flows');
    });
});
