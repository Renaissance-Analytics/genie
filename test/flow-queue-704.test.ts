import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { Resolution } from '../src/core/inbox.js';
import type { NodeOutcome } from '../src/core/flow-canvas.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { HeldBack, createFlowRunner, type AgentSessionsPort } from '../src/main/flow-runner.js';
import { waitingPrompter } from './helpers/waiting-prompter.js';
import type { FlowRecord } from '../src/main/flow-store.js';

/**
 * TYNN #704, AS TYNN #826 LEFT IT: a flow's prompt for an agent mid-turn used to be DROPPED ("held back: busy"); #704 queued
 * it for the turn's end, and the step waited for that turn AND its own — which failed long turns (#826). Now it goes as a
 * typed message does: into the running turn where the provider reads one (Claude, test/flow-busy-agent-826.test.ts), HELD by
 * the session for the turn's end where it refuses one (Codex, here). With `waitForReply` the step then waits for the held
 * prompt's own turn and hands on its reply. A second fire for the same agent while the first is still held replaces it: one
 * waits, never two. The agent stopping while it is held no longer fails the run: the session kept it for the next run.
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

/** A Codex agent's session the way the host answers it: a message mid-turn is HELD for the turn's end. */
function heldSessions(turnState: 'working' | 'idle') {
    const state = { running: true, turnState, pendingApproval: null as unknown };
    const rows: Array<{ event: unknown }> = [];
    const listeners = new Set<(id: string) => void>();
    const prompts: Array<[string, string]> = [];
    const queue: Array<{ id: string; text: string; by: string }> = [];
    const calls = { deliver: 0 };
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
        deliver: (_id, text, by, replacing) => {
            calls.deliver += 1;
            if (replacing !== null) { const at = queue.findIndex((q) => q.id === replacing); if (at >= 0) queue.splice(at, 1); }
            if (state.turnState !== 'working') { send(text, by); return { id: null }; }
            const id = `q${++n}`;
            queue.push({ id, text, by });
            return { id };
        },
        isQueued: (_id, promptId) => queue.some((q) => q.id === promptId),
    };
    /** The turn in progress ends with `said`; the held prompt then goes as its own turn. */
    const endTurn = (said: string) => {
        rows.push({ event: { kind: 'message', speaker: 'agent', peerName: null, text: said } });
        state.turnState = 'idle';
        const next = queue.shift();
        if (next) send(next.text, next.by);
        notify();
    };
    /** A stop: the session keeps what it held (owed for the next run), and the queue is empty. */
    const stop = () => { state.running = false; state.turnState = 'idle'; queue.length = 0; notify(); };
    return { state, port, prompts, queue, rows, endTurn, stop, calls };
}

const prompter = (sessions: AgentSessionsPort) =>
    waitingPrompter({ sessions, resolve: resolveAddress, agent: (id) => roster[id] ?? null, asleep: () => false, by: 'flow "nightly report"' });

describe('waitForReply on a BUSY Codex agent: held for the turn end, its own turn\'s reply handed on (Tynn #704, #826)', () => {
    it('held behind the turn, never inside it; sent ONCE when the turn ends; the reply is its own turn', async () => {
        const s = heldSessions('working');
        const notes: string[] = [];
        const replied = prompter(s.port)('claude:atlas', 'check the queue', { delivered: (how, note) => notes.push(`${how}: ${note}`) });
        await tick();
        expect(s.prompts).toEqual([]);
        expect(s.queue).toHaveLength(1);
        expect(notes).toEqual([expect.stringMatching(/^accepted: .*holds the prompt, and it goes when its current turn ends/)]);
        s.endTurn('the earlier turn, not ours');
        await tick();
        expect(s.prompts).toEqual([['check the queue', 'flow "nightly report"']]);
        s.endTurn('queue is empty');
        expect(await replied).toBe('queue is empty');
        expect(s.prompts).toHaveLength(1);
    });

    it('an IDLE agent is prompted at once, as before; nothing is held', async () => {
        const s = heldSessions('idle');
        const replied = prompter(s.port)('claude:atlas', 'check the queue');
        expect(s.prompts).toEqual([['check the queue', 'flow "nightly report"']]);
        s.endTurn('done');
        expect(await replied).toBe('done');
        expect(s.calls.deliver).toBe(0);
    });

    it('a second fire while the first is still held REPLACES it: one prompt waits, and each says what happened', async () => {
        const s = heldSessions('working');
        const first = prompter(s.port)('claude:atlas', 'old numbers', {});
        const firstSettled = first.then(() => 'replied', (e: unknown) => e);
        await tick();
        const notes: string[] = [];
        const second = prompter(s.port)('claude:atlas', 'new numbers', { delivered: (_how, note) => notes.push(note) });
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

    it('a port that cannot hand a message over mid-turn still holds the prompt back, as before', async () => {
        const s = heldSessions('working');
        const { deliver: _d, isQueued: _i, ...plain } = s.port;
        await expect(prompter(plain)('claude:atlas', 'x', {})).rejects.toBeInstanceOf(HeldBack);
        expect(s.prompts).toEqual([]);
    });

    it('the agent stopping while the prompt is held: the session kept it, and the step reads waiting (it used to FAIL the run)', async () => {
        const s = heldSessions('working');
        const said: string[] = [];
        const settled = prompter(s.port)('claude:atlas', 'x', { delivered: (how) => said.push(how) }).then((r) => ({ r }), (e: unknown) => e);
        await tick();
        s.stop();
        expect(await settled).toEqual({ r: '' });
        expect(said).toEqual(['accepted', 'waiting']);
    });
});

describe('the run shows running, then ran (Tynn #704, #826)', () => {
    it('through the runner with waitForReply: the step runs while its prompt is held, its log says accepted, then ran', async () => {
        const s = heldSessions('working');
        const flow = flowOf([trigger, step('genie/agent_prompt', { agent: 'claude:atlas', prompt: 'check the queue', waitForReply: true })], [edge('t', 's')]);
        const seen: Array<Record<string, NodeOutcome>> = [];
        const logs: string[] = [];
        const ports = (): FlowPorts => ({
            promptAgent: prompter(s.port),
            runCommand: async () => ({ exitCode: 0, output: '' }),
            addKnowledge: async () => ({ id: 'kn' }),
        });
        const running = createFlowRunner({ ports, asleep: () => false })(flow, schedule, { nodes: (o) => seen.push({ ...o }), log: (_n, line) => logs.push(line) });
        await tick();
        expect(seen.at(-1)).toMatchObject({ s: 'running' });
        expect(logs.join(' ')).toMatch(/accepted/);
        s.endTurn('earlier');
        await tick();
        expect(seen.at(-1)).toMatchObject({ s: 'running' });
        s.endTurn('queue is empty');
        expect(await running).toEqual({ outcome: 'ran' });
        expect(seen.at(-1)).toMatchObject({ s: 'ran' });
    });
});
