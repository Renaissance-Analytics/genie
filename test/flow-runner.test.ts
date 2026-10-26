import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { Resolution } from '../src/core/inbox.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { HeldBack, agentPrompter, createFlowRunner, supervisedCommand, type AgentSessionsPort } from '../src/main/flow-runner.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore, type FlowRecord } from '../src/main/flow-store.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import type { PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * SCHEDULED TASKS ACTUALLY RUN (hosting ship line P4). Until now the composition root wired the scheduler with
 * `run: async () => {}` — a fired flow was recorded as run and nothing executed. The runner executes the flow's
 * document on fancy-flow's own engine with Genie's executors:
 * - `genie/terminal_run` runs its command as a SUPERVISED process, whose output the supervisor keeps (P1);
 * - `genie/agent_prompt` prompts a live agent and waits for its turn — HELD BACK while the agent is mid-turn;
 * - `genie/knowledge_add` writes a node.
 * Every run answers an outcome: ran, failed with the reason, or held back with why (the workspace hibernated,
 * the agent busy, the previous command still going). Names here are RFC 2606 / invented; no agent, pty or store
 * is real except the engine, the supervisor and a temp-dir flow store.
 */

const user = { kind: 'user' } as const;
const WS = { id: 'ws-example', path: resolve(tmpdir(), 'genie2-flow-runner-ws') };

const flowOf = (nodes: unknown[], edges: unknown[] = [], over: Partial<FlowRecord> = {}): FlowRecord => ({
    id: 'flow_example',
    workspaceId: WS.id,
    name: 'nightly report',
    document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } },
    armed: true,
    createdBy: user,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    refusals: [],
    runs: [],
    ...over,
});
const trigger = { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } };
const step = (kind: string, config: Record<string, unknown>, id = 's') => ({ id, kind, position: { x: 240, y: 0 }, config });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const schedule = { nodeId: 't', cron: '0 3 * * *', timezone: undefined };

function countingPorts(over: Partial<FlowPorts> = {}): FlowPorts & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
        calls,
        promptAgent: async (address, text) => { calls.push(['prompt', address, text]); return 'done'; },
        runCommand: async (workspaceId, command, cwd) => { calls.push(['run', workspaceId, command, cwd]); return { exitCode: 0, output: 'report written\n' }; },
        addKnowledge: async (input) => { calls.push(['knowledge', input]); return { id: 'kn_1' }; },
        ...over,
    };
}

describe('the runner — a fired flow EXECUTES its steps and answers an outcome', () => {
    it('a command step runs ONCE with its workspace, command and folder; the outcome is ran', async () => {
        const ports = countingPorts();
        const run = createFlowRunner({ ports: () => ports, asleep: () => false });
        const result = await run(flowOf([trigger, step('genie/terminal_run', { workspace: WS.id, command: 'npm run report', cwd: 'repos/app' })], [edge('t', 's')]), schedule);
        expect(result).toEqual({ outcome: 'ran' });
        expect(ports.calls).toEqual([['run', WS.id, 'npm run report', 'repos/app']]);
    });

    it('steps run in order and hand on their output: the command’s output becomes the knowledge node’s body', async () => {
        const ports = countingPorts();
        const run = createFlowRunner({ ports: () => ports, asleep: () => false });
        const flow = flowOf(
            [trigger, step('genie/terminal_run', { workspace: WS.id, command: 'npm run report' }, 'r'), step('genie/knowledge_add', { workspace: WS.id, title: 'Nightly report', body: '{{in.output}}' }, 'k')],
            [edge('t', 'r'), edge('r', 'k')],
        );
        expect(await run(flow, schedule)).toEqual({ outcome: 'ran' });
        expect(ports.calls.map((c) => c[0])).toEqual(['run', 'knowledge']);
        expect(ports.calls[1]![1]).toMatchObject({ title: 'Nightly report', body: 'report written\n', scope: { kind: 'workspace', id: WS.id } });
    });

    it('a failing step FAILS the run with its reason — a non-zero exit; a kind the engine does not know fails before ANY step runs', async () => {
        const failing = createFlowRunner({ ports: () => countingPorts({ runCommand: async () => ({ exitCode: 2, output: 'boom' }) }), asleep: () => false });
        expect(await failing(flowOf([trigger, step('genie/terminal_run', { workspace: WS.id, command: 'npm test' })], [edge('t', 's')]), schedule)).toEqual({ outcome: 'failed', reason: 'npm test ended with exit code 2', steps: [{ nodeId: 's', label: 'runs the command `npm test`', outcome: 'failed' }] });

        // Read through the engine (flow-kinds.ts) as the store reads it: refused as unknown, so the command before it never runs either.
        const ports = countingPorts();
        const unknown = createFlowRunner({ ports: () => ports, asleep: () => false });
        const r = await unknown(flowOf([trigger, step('genie/terminal_run', { workspace: WS.id, command: 'npm run report' }, 'r'), step('genie/no_such_kind', {})], [edge('t', 'r'), edge('r', 's')]), schedule);
        expect(r).toEqual({ outcome: 'failed', reason: 'the flow document was refused by the engine: node s: Unknown kind "genie/no_such_kind" — register it before importing.' });
        expect(ports.calls).toEqual([]);
    });

    it('a HIBERNATED workspace holds the run back and says why; nothing executes (control: awake, the same flow runs)', async () => {
        const ports = countingPorts();
        const flow = flowOf([trigger, step('genie/terminal_run', { workspace: WS.id, command: 'npm run report' })], [edge('t', 's')]);
        const asleep = await createFlowRunner({ ports: () => ports, asleep: (id) => id === WS.id })(flow, schedule);
        expect(asleep).toEqual({ outcome: 'held', reason: `its workspace ${WS.id} is hibernated; nothing runs there until it is woken` });
        expect(ports.calls).toHaveLength(0);
        expect(await createFlowRunner({ ports: () => ports, asleep: () => false })(flow, schedule)).toEqual({ outcome: 'ran' });
        expect(ports.calls).toHaveLength(1);
    });

    it('a step that HOLDS BACK makes the run held, with the step’s words — not failed', async () => {
        const run = createFlowRunner({ ports: () => countingPorts({ promptAgent: async () => { throw new HeldBack('atlas is busy (mid-turn); the prompt was not delivered, so it never lands inside another turn'); } }), asleep: () => false });
        const result = await run(flowOf([trigger, step('genie/agent_prompt', { agent: 'claude:atlas', prompt: 'check in' })], [edge('t', 's')]), schedule);
        expect(result).toEqual({ outcome: 'held', reason: 'atlas is busy (mid-turn); the prompt was not delivered, so it never lands inside another turn', steps: [{ nodeId: 's', label: 'prompts claude:atlas', outcome: 'held' }] });
    });

    it('a flow with no nodes fails with the reason rather than reading as run', async () => {
        expect(await createFlowRunner({ ports: () => countingPorts(), asleep: () => false })(flowOf([]), null)).toEqual({ outcome: 'failed', reason: 'the flow has no steps to run' });
    });
});

describe('through the scheduler — a due ARMED flow runs its step once, a DISARMED one never', () => {
    let dir: string;
    let clock = Date.UTC(2026, 9, 15, 2, 59, 0);
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-flow-runner-'));
        clock = Date.UTC(2026, 9, 15, 2, 59, 0);
    });
    afterEach(async () => rm(dir, { recursive: true, force: true }));

    it('counted: at the due the armed flow’s command ran exactly once and its run is recorded ran; the disarmed flow’s never ran', async () => {
        const store = await FlowStore.open(dir, () => clock);
        const timers: Array<{ at: number; fn: () => void }> = [];
        const ports = countingPorts();
        const scheduler = new FlowScheduler({
            store,
            now: () => clock,
            schedule: (fn, ms) => {
                const t = { at: clock + ms, fn };
                timers.push(t);
                return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
            },
            run: createFlowRunner({ ports: () => ports, asleep: () => false, now: () => clock }),
        });
        const doc = (command: string) => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [{ ...trigger, config: { cron: '0 3 * * *', timezone: 'UTC' } }, step('genie/terminal_run', { workspace: WS.id, command })], edges: [edge('t', 's')] } });
        const armed = await store.create({ workspaceId: WS.id, name: 'armed', document: doc('npm run armed'), by: user, armed: true });
        const disarmed = await store.create({ workspaceId: WS.id, name: 'disarmed', document: doc('npm run disarmed'), by: user });
        scheduler.plan();
        clock = Date.UTC(2026, 9, 15, 3, 0, 0);
        for (const t of timers.splice(0)) if (t.at <= clock) t.fn();
        await scheduler.settled();
        expect(ports.calls).toEqual([['run', WS.id, 'npm run armed', undefined]]);
        expect(store.get(armed.id)!.runs.map((r) => [r.trigger, r.outcome])).toEqual([['schedule', 'ran']]);
        expect(store.get(disarmed.id)!.runs).toEqual([]);
    });
});

/** A pty engine that answers each command with scripted output and an exit code, as a real one would, a tick later. */
function scriptedPty(script: (command: string) => { output: string; exit: number } | null) {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const data = new Set<(id: string, d: string) => void>();
    const exits = new Set<(id: string, code: number) => void>();
    let n = 0;
    const port: PtyPort = {
        open(o) {
            const id = `pty_${++n}`;
            opened.push({ ...o, id });
            const answer = script(o.command ?? '');
            if (answer) {
                setTimeout(() => {
                    for (const l of data) l(id, answer.output);
                    for (const l of exits) l(id, answer.exit);
                }, 0);
            }
            return { id, pid: 7000 + n, shell: 'sh', scrollback: '' };
        },
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => '',
        onData: (l) => { data.add(l); return () => { data.delete(l); }; },
        onExit: (l) => { exits.add(l); return () => { exits.delete(l); }; },
    };
    return { port, opened };
}

describe('genie/terminal_run through the SUPERVISOR — the output is kept like a background process’s log (P1)', () => {
    const workspacePath = (id: string) => (id === WS.id ? WS.path : null);

    it('runs in the workspace folder, never restarted, and answers the exit code with THIS run’s output; the log keeps every run', async () => {
        const pty = scriptedPty((command) => (command === 'npm run report' ? { output: 'report written\n', exit: 0 } : { output: 'disk full\n', exit: 3 }));
        const supervisor = new ProcessSupervisor(pty.port);
        const run = supervisedCommand({ supervisor, workspacePath, envFor: () => ({ DB_HOST: '127.0.0.1' }) }, { processId: 'flow-run:flow_example', name: 'flow: nightly report' });

        const first = await run(WS.id, 'npm run report', 'repos/app');
        expect(first.exitCode).toBe(0);
        expect(first.output).toContain('report written');
        expect(pty.opened).toHaveLength(1);
        expect(pty.opened[0]).toMatchObject({ command: 'npm run report', cwd: resolve(WS.path, 'repos/app'), env: { DB_HOST: '127.0.0.1' } });
        expect(supervisor.status('flow-run:flow_example')).toMatchObject({ state: 'exited', exitCode: 0, restarts: 0, workspaceId: WS.id, name: 'flow: nightly report' });

        const second = await run(WS.id, 'npm run broken', undefined);
        expect(second.exitCode).toBe(3);
        expect(second.output).toContain('disk full');
        expect(second.output).not.toContain('report written');
        expect(pty.opened[1]).toMatchObject({ cwd: resolve(WS.path) });
        // The supervisor's log is the PROCESS's: both runs are in it, after the run ended — readable as any process's is.
        const log = supervisor.log('flow-run:flow_example')!;
        expect(log).toContain('report written');
        expect(log).toContain('disk full');
    });

    it('refuses before starting anything: an unknown workspace, a folder outside the workspace', async () => {
        const pty = scriptedPty(() => ({ output: '', exit: 0 }));
        const run = supervisedCommand({ supervisor: new ProcessSupervisor(pty.port), workspacePath }, { processId: 'flow-run:x', name: 'flow: x' });
        await expect(run('ws-unknown', 'npm test', undefined)).rejects.toThrow(/workspace ws-unknown is not registered/);
        await expect(run(WS.id, 'npm test', '../elsewhere')).rejects.toThrow(/outside the workspace/);
        expect(pty.opened).toHaveLength(0);
    });

    it('a previous run of the flow’s command still going HOLDS this one back; nothing is started beside it', async () => {
        const pty = scriptedPty(() => null); // never exits on its own
        const supervisor = new ProcessSupervisor(pty.port);
        const run = supervisedCommand({ supervisor, workspacePath }, { processId: 'flow-run:slow', name: 'flow: slow' });
        void run(WS.id, 'npm run slow', undefined).catch(() => {});
        await expect(run(WS.id, 'npm run slow', undefined)).rejects.toBeInstanceOf(HeldBack);
        expect(pty.opened).toHaveLength(1);
        // The person's Stop of the first: it ends as stopped, not as a clean exit.
        const pending = new Promise<unknown>((r) => { supervisor.onChange((s) => { if (s.state === 'stopped') r(s); }); });
        supervisor.stop('flow-run:slow');
        await pending;
    });
});

/** Sessions the way the session host answers: a probe per agent, a ledger, prompt, and a change feed. */
function fakeSessions(initial: Record<string, { running: boolean; turnState: string; pendingApproval?: unknown }>) {
    const state = new Map(Object.entries(initial));
    const rows = new Map<string, Array<{ event: unknown }>>();
    const listeners = new Set<(id: string) => void>();
    const prompts: Array<[string, string, string]> = [];
    const port: AgentSessionsPort = {
        session: (id) => state.get(id) ?? null,
        rows: (id) => rows.get(id) ?? [],
        prompt: (id, text, by) => {
            const s = state.get(id);
            if (!s?.running) return false;
            prompts.push([id, text, by]);
            state.set(id, { ...s, turnState: 'working' });
            return true;
        },
        subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
    /** The agent's turn ends with what it said. */
    const finishTurn = (id: string, said: string) => {
        rows.set(id, [...(rows.get(id) ?? []), { event: { kind: 'message', speaker: 'agent', peerName: null, text: said } }]);
        state.set(id, { ...state.get(id)!, turnState: 'idle' });
        for (const l of listeners) l(id);
    };
    return { port, prompts, finishTurn, rows };
}

describe('genie/agent_prompt on a live agent — held back while it is busy, never queued inside its turn', () => {
    const roster: Record<string, { name: string; workspaceId: string }> = { agent_atlas: { name: 'atlas', workspaceId: WS.id }, agent_sleepy: { name: 'sleepy', workspaceId: 'ws-sleepy' } };
    const resolveAddress = (text: string): Resolution =>
        text === 'claude:atlas' ? { kind: 'one', id: 'agent_atlas' as never } : text === 'claude:sleepy' ? { kind: 'one', id: 'agent_sleepy' as never } : text === 'claude:twin' ? { kind: 'ambiguous', forms: ['ws-a:claude:twin', 'ws-b:claude:twin'] } : { kind: 'none' };
    const prompter = (sessions: AgentSessionsPort) =>
        agentPrompter({ sessions, resolve: resolveAddress, agent: (id) => roster[id] ?? null, asleep: (ws) => ws === 'ws-sleepy', by: 'flow "nightly report"' });

    it('an IDLE agent is prompted once, as the flow, and the reply is what it said in that turn', async () => {
        const s = fakeSessions({ agent_atlas: { running: true, turnState: 'idle', pendingApproval: null } });
        s.rows.set('agent_atlas', [{ event: { kind: 'message', speaker: 'agent', peerName: null, text: 'an earlier turn' } }]);
        const replied = prompter(s.port)('claude:atlas', 'check the queue');
        expect(s.prompts).toEqual([['agent_atlas', 'check the queue', 'flow "nightly report"']]);
        s.finishTurn('agent_atlas', 'queue is empty');
        expect(await replied).toBe('queue is empty');
    });

    it('a BUSY agent (mid-turn, or parked on an approval) is HELD back and never prompted', async () => {
        const working = fakeSessions({ agent_atlas: { running: true, turnState: 'working', pendingApproval: null } });
        await expect(prompter(working.port)('claude:atlas', 'check the queue')).rejects.toBeInstanceOf(HeldBack);
        await expect(prompter(working.port)('claude:atlas', 'check the queue')).rejects.toThrow(/atlas is busy \(mid-turn\)/);
        const parked = fakeSessions({ agent_atlas: { running: true, turnState: 'idle', pendingApproval: { id: 'ap_1' } } });
        await expect(prompter(parked.port)('claude:atlas', 'check the queue')).rejects.toBeInstanceOf(HeldBack);
        expect([...working.prompts, ...parked.prompts]).toEqual([]);
    });

    it('an agent whose workspace is hibernated is HELD back', async () => {
        const s = fakeSessions({ agent_sleepy: { running: true, turnState: 'idle', pendingApproval: null } });
        const refused = prompter(s.port)('claude:sleepy', 'wake up');
        await expect(refused).rejects.toBeInstanceOf(HeldBack);
        await expect(prompter(s.port)('claude:sleepy', 'wake up')).rejects.toThrow(/sleepy's workspace is hibernated/);
        expect(s.prompts).toEqual([]);
    });

    it('FAILS (not held) with the reason: an agent that is not running, an address nobody answers to, an ambiguous one', async () => {
        const s = fakeSessions({ agent_atlas: { running: false, turnState: 'stopped', pendingApproval: null } });
        await expect(prompter(s.port)('claude:atlas', 'x')).rejects.toThrow(/atlas is not running/);
        await expect(prompter(s.port)('claude:atlas', 'x')).rejects.not.toBeInstanceOf(HeldBack);
        await expect(prompter(s.port)('claude:nobody', 'x')).rejects.toThrow(/no agent answers to claude:nobody/);
        await expect(prompter(s.port)('claude:twin', 'x')).rejects.toThrow(/names more than one agent \(ws-a:claude:twin, ws-b:claude:twin\)/);
    });

    it('end to end through the runner: a busy agent makes the run HELD; idle, the same flow RAN and the agent was prompted once', async () => {
        const flow = flowOf([trigger, step('genie/agent_prompt', { agent: 'claude:atlas', prompt: 'check the queue' })], [edge('t', 's')]);
        const busy = fakeSessions({ agent_atlas: { running: true, turnState: 'working', pendingApproval: null } });
        const heldRun = await createFlowRunner({ ports: () => ({ ...countingPorts(), promptAgent: prompter(busy.port) }), asleep: () => false })(flow, schedule);
        expect(heldRun).toMatchObject({ outcome: 'held' });
        expect(busy.prompts).toEqual([]);

        const idle = fakeSessions({ agent_atlas: { running: true, turnState: 'idle', pendingApproval: null } });
        const running = createFlowRunner({ ports: () => ({ ...countingPorts(), promptAgent: prompter(idle.port) }), asleep: () => false })(flow, schedule);
        await new Promise((r) => setTimeout(r, 0));
        expect(idle.prompts).toHaveLength(1);
        idle.finishTurn('agent_atlas', 'queue is empty');
        expect(await running).toEqual({ outcome: 'ran' });
    });
});
