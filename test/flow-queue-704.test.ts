import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { Resolution } from '../src/core/inbox.js';
import type { NodeOutcome } from '../src/core/flow-canvas.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { HeldBack, agentPrompter, createFlowRunner, type AgentSessionsPort } from '../src/main/flow-runner.js';
import type { FlowRecord } from '../src/main/flow-store.js';

/**
 * TYNN #704: a flow's prompt for an agent that is mid-turn used to be DROPPED ("held back: busy; the prompt was not
 * delivered"). It is QUEUED now, in the agent's own queue (the one typed messages and mail wait in), and goes as its own
 * turn the moment the current one ends — never inside it. The run shows queued, then ran (or failed, with why). A second
 * fire for the same agent while the first is still queued replaces it: one prompt waits, never two.
 */

const user = { kind: 'user' } as const;
const WS = { id: 'ws-example', path: resolve(tmpdir(), 'genie2-flow-queue-704') };
const flowOf = (nodes: unknown[], edges: unknown[] = []): FlowRecord => ({
    id: 'flow_example', workspaceId: WS.id, name: 'nightly report',
    document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } },
    armed: true, createdBy: user, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', refusals: [], runs: [],
});
const trigger = { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } };
const step = (kind: string, config: Record<string, unknown>, id = 's') => ({ id, kind, position: { x: 240, y: 0 }, config });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const schedule = { nodeId: 't', cron: '0 3 * * *', timezone: undefined };
const tick = () => new Promise((r) => setTimeout(r, 0));

const roster: Record<string, { name: string; workspaceId: string }> = { agent_atlas: { name: 'atlas', workspaceId: WS.id } };
const resolveAddress = (text: string): Resolution => (text === 'claude:atlas' ? { kind: 'one', id: 'agent_atlas' as never } : { kind: 'none' });

/** An agent session the way the host answers it, WITH its queue: a prompt that cannot go now waits for the turn's end. */
function queueingSessions(turnState: 'working' | 'idle') {
    const state = { running: true, turnState, pendingApproval: null as unknown };
    const rows: Array<{ event: unknown }> = [];
    const listeners = new Set<(id: string) => void>();
    const prompts: Array<[string, string]> = [];
    const queue: Array<{ id: string; text: string; by: string }> = [];
    const calls = { queue: 0 };
    let n = 0;
    const notify = () => { for (const l of listeners) l('agent_atlas'); };
    const send = (text: string, by: string) => {
        prompts.push([text, by]);
        state.turnState = 'working';
        rows.push({ event: { kind: 'turn', by } });
    };
    const port: AgentSessionsPort = {
        session: () => state as never,
        rows: () => rows,
        prompt: (_id, text, by) => { send(text, by); return true; },
        subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        queue: (_id, text, by, replacing) => {
            calls.queue += 1;
            if (replacing !== null) { const at = queue.findIndex((q) => q.id === replacing); if (at >= 0) queue.splice(at, 1); }
            const id = `q${++n}`;
            queue.push({ id, text, by });
            return { id };
        },
        isQueued: (_id, promptId) => queue.some((q) => q.id === promptId),
    };
    /** The turn in progress ends with `said`; the queue's next prompt then goes as its own turn. */
    const endTurn = (said: string) => {
        rows.push({ event: { kind: 'message', speaker: 'agent', peerName: null, text: said } });
        state.turnState = 'idle';
        const next = queue.shift();
        if (next) send(next.text, next.by);
        notify();
    };
    return { state, port, prompts, queue, rows, endTurn, calls };
}

const prompter = (sessions: AgentSessionsPort) =>
    agentPrompter({ sessions, resolve: resolveAddress, agent: (id) => roster[id] ?? null, asleep: () => false, by: 'flow "nightly report"' });

describe('a flow prompt for a BUSY agent is queued, not dropped (Tynn #704)', () => {
    it('queued behind the turn, never inside it; delivered ONCE when the turn ends; the reply is its own turn', async () => {
        const s = queueingSessions('working');
        const notes: string[] = [];
        let started = 0;
        const replied = prompter(s.port)('claude:atlas', 'check the queue', { queued: (note) => notes.push(note), started: () => { started += 1; } });
        await tick();
        expect(s.prompts).toEqual([]);
        expect(s.queue).toHaveLength(1);
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatch(/queued/);
        expect(started).toBe(0);
        s.endTurn('the earlier turn, not ours');
        await tick();
        expect(s.prompts).toEqual([['check the queue', 'flow "nightly report"']]);
        expect(started).toBe(1);
        s.endTurn('queue is empty');
        expect(await replied).toBe('queue is empty');
        expect(s.prompts).toHaveLength(1);
    });

    it('an IDLE agent is prompted at once, as before; nothing is queued', async () => {
        const s = queueingSessions('idle');
        const replied = prompter(s.port)('claude:atlas', 'check the queue', { queued: () => { throw new Error('not queued'); } });
        expect(s.prompts).toEqual([['check the queue', 'flow "nightly report"']]);
        s.endTurn('done');
        expect(await replied).toBe('done');
        expect(s.calls.queue).toBe(0);
    });

    it('a second fire while the first is still queued REPLACES it: one prompt waits, and each says what happened', async () => {
        const s = queueingSessions('working');
        const first = prompter(s.port)('claude:atlas', 'old numbers', {});
        const firstSettled = first.then(() => 'replied', (e: unknown) => e);
        await tick();
        const notes: string[] = [];
        const second = prompter(s.port)('claude:atlas', 'new numbers', { queued: (note) => notes.push(note) });
        await tick();
        expect(s.queue).toHaveLength(1);
        expect(s.queue[0]!.text).toBe('new numbers');
        expect(notes.join(' ')).toMatch(/replac/);
        const earlier = await firstSettled;
        expect(earlier).toBeInstanceOf(HeldBack);
        expect((earlier as Error).message).toMatch(/replaced by a later fire/);
        s.endTurn('earlier turn');
        await tick();
        expect(s.prompts).toEqual([['new numbers', 'flow "nightly report"']]);
        s.endTurn('fresh answer');
        expect(await second).toBe('fresh answer');
    });

    it('a port that cannot queue still holds the prompt back, as before', async () => {
        const s = queueingSessions('working');
        const { queue: _q, isQueued: _i, ...plain } = s.port;
        await expect(prompter(plain)('claude:atlas', 'x', {})).rejects.toBeInstanceOf(HeldBack);
        expect(s.prompts).toEqual([]);
    });

    it('the agent stopping while the prompt is queued FAILS the run in words (not held, not silent)', async () => {
        const s = queueingSessions('working');
        const settled = prompter(s.port)('claude:atlas', 'x', {}).then(() => null, (e: unknown) => e);
        await tick();
        s.state.running = false;
        s.endTurn('gone');
        const error = await settled;
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(HeldBack);
        expect((error as Error).message).toMatch(/atlas stopped/);
    });
});

describe('the run shows queued, then ran (Tynn #704)', () => {
    it('through the runner: the prompt step is queued while it waits, then ran; the run outcome is ran', async () => {
        const s = queueingSessions('working');
        const flow = flowOf([trigger, step('genie/agent_prompt', { agent: 'claude:atlas', prompt: 'check the queue' })], [edge('t', 's')]);
        const seen: Array<Record<string, NodeOutcome>> = [];
        const logs: string[] = [];
        const ports = (): FlowPorts => ({
            promptAgent: prompter(s.port),
            runCommand: async () => ({ exitCode: 0, output: '' }),
            addKnowledge: async () => ({ id: 'kn' }),
        });
        const running = createFlowRunner({ ports, asleep: () => false })(flow, schedule, { nodes: (o) => seen.push({ ...o }), log: (_n, line) => logs.push(line) });
        await tick();
        expect(seen.at(-1)).toMatchObject({ s: 'queued' });
        expect(logs.join('\n')).toMatch(/queued/);
        s.endTurn('earlier');
        await tick();
        expect(seen.at(-1)).toMatchObject({ s: 'running' });
        s.endTurn('queue is empty');
        expect(await running).toEqual({ outcome: 'ran' });
        expect(seen.at(-1)).toMatchObject({ s: 'ran' });
    });
});
