import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { NodeOutcome } from '../src/core/flow-canvas.js';
import type { Resolution } from '../src/core/inbox.js';
import type { FlowPorts, PromptDelivery, PromptHooks, PromptOptions } from '../src/main/flow-executors.js';
import { FLOW_TURN_QUIET_MS, agentPrompter, createFlowRunner, deliverKeptOnNextRun, type AgentLimitView, type AgentSessionsPort } from '../src/main/flow-runner.js';
import type { FlowRecord } from '../src/main/flow-store.js';

/**
 * TYNN #826: A FLOW'S PROMPT TO A BUSY AGENT IS DELIVERED, NOT FAILED.
 *
 * Reported from a workspace whose scheduled flows (schedule -> run a command -> prompt the workspace's agent) failed at the
 * prompt step: the agent's turns are long (background jobs waiting ~40 minutes, some inside rate-limit pauses), the step
 * queued its prompt behind the turn (Tynn #704) and then waited for the WHOLE turn, and "nothing new for 30 minutes"
 * failed the run — or the agent stopped around a restart before the queued prompt went, and that failed it too. The
 * prompts reached the agent later; the runs already said failed.
 *
 * The contract now, as Genie 1's flows had it (an `agentinbox send` step was done once the message was handed over):
 * - the prompt goes MID-TURN where the provider takes it (Claude), or is held by the provider's session for the turn's end
 *   (Codex); either way the step is done then — delivered or accepted. Waiting for the reply is an option (`waitForReply`);
 * - a wait never counts a window with a running background job, or a provider limit, as "nothing new";
 * - no run to take it (stopped, start refused, Genie restarting) KEEPS the prompt in the agent's thread, and the agent's
 *   next run gets it; the step reads waiting, never failed.
 * Driven by a hand timer and an inert session: nothing here waits on a real clock or runs an agent.
 */

const BY = 'flow "nightly report"';
const WS = { id: 'ws-example', path: resolve(tmpdir(), 'genie2-flow-826') };
const roster: Record<string, { name: string; workspaceId: string }> = { agent_atlas: { name: 'atlas', workspaceId: WS.id } };
const resolveAddress = (text: string): Resolution => (text === 'claude:atlas' ? { kind: 'one', id: 'agent_atlas' as never } : { kind: 'none' });
const tick = () => new Promise((r) => setTimeout(r, 0));

function handTimer() {
    let clock = 0;
    const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
    return {
        after(ms: number, fn: () => void) {
            const t = { at: clock + ms, fn, cancelled: false };
            timers.push(t);
            return () => { t.cancelled = true; };
        },
        advance(ms: number) {
            const until = clock + ms;
            for (;;) {
                const due = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                due.cancelled = true;
                clock = due.at;
                due.fn();
            }
            clock = until;
        },
        armed: () => timers.filter((t) => !t.cancelled).length,
    };
}

/**
 * An agent's session as the host answers a flow: Claude takes a message inside its running turn; Codex's session holds it
 * for the turn's end. A stop leaves what it held kept by the session itself (`#leaveQueuedAsDrafts`).
 */
function agent(provider: 'claude' | 'codex', turnState: 'working' | 'idle', options: { keep?: boolean; deliver?: boolean } = {}) {
    const state = { running: true, turnState: turnState as string, pendingApproval: null as unknown, background: 0 as number | null, limit: undefined as AgentLimitView | undefined, refusePrompt: false, startAnswer: false };
    const rows: Array<{ event: unknown }> = [];
    const listeners = new Set<(id: string) => void>();
    const turns: Array<[string, string]> = [];
    const midTurn: Array<[string, string]> = [];
    const held: Array<{ id: string; text: string; by: string }> = [];
    const kept: Array<[string, string, string]> = [];
    let n = 0;
    const notify = () => { for (const l of listeners) l('agent_atlas'); };
    const newTurn = (text: string, by: string) => { turns.push([text, by]); state.turnState = 'working'; rows.push({ event: { kind: 'turn', by } }); };
    const port: AgentSessionsPort = {
        session: () => state as never,
        rows: () => rows,
        start: async () => { if (state.startAnswer) state.running = true; return state.startAnswer; },
        prompt: (_id, text, by) => { if (!state.running || state.refusePrompt) return false; newTurn(text, by); return true; },
        subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        isQueued: (_id, promptId) => held.some((q) => q.id === promptId),
        ...(options.deliver === false ? {} : {
            deliver: (_id: string, text: string, by: string, replacing: string | null) => {
                if (!state.running) return null;
                if (replacing !== null) { const at = held.findIndex((q) => q.id === replacing); if (at >= 0) held.splice(at, 1); }
                if (state.turnState !== 'working') { newTurn(text, by); return { id: null }; }
                if (provider === 'claude') { midTurn.push([text, by]); rows.push({ event: { kind: 'message', speaker: 'peer', text } }); return { id: null }; }
                const id = `q${++n}`;
                held.push({ id, text, by });
                return { id };
            },
        }),
        ...(options.keep === false ? {} : { keep: (agentId: string, text: string, by: string) => { kept.push([agentId, text, by]); } }),
    };
    return {
        state, port, rows, turns, midTurn, held, kept, notify,
        /** A sign of life in the ledger. */
        activity: () => { rows.push({ event: { kind: 'tool', name: 'Bash' } }); notify(); },
        /** The running turn ends with `said`; Codex's held prompt then goes as its own turn. */
        endTurn: (said: string) => {
            rows.push({ event: { kind: 'message', speaker: 'agent', peerName: null, text: said } });
            state.turnState = 'idle';
            const next = held.shift();
            if (next) newTurn(next.text, next.by);
            notify();
        },
        /** The agent stops: what its session held is kept by the session (undelivered, owed), not lost. */
        stop: () => { state.running = false; state.turnState = 'idle'; held.length = 0; notify(); },
    };
}

async function settledState(p: Promise<unknown>): Promise<{ state: 'pending' } | { state: 'resolved'; value: unknown } | { state: 'rejected'; error: Error }> {
    let out: { state: 'pending' } | { state: 'resolved'; value: unknown } | { state: 'rejected'; error: Error } = { state: 'pending' };
    p.then((value) => { out = { state: 'resolved', value }; }, (error: Error) => { out = { state: 'rejected', error }; });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await tick();
    return out;
}

function ask(port: AgentSessionsPort, options: PromptOptions = {}) {
    const timer = handTimer();
    const said: Array<[PromptDelivery, string]> = [];
    const hooks: PromptHooks = { delivered: (how, note) => said.push([how, note]) };
    const asked = agentPrompter({ sessions: port, resolve: resolveAddress, agent: (id) => roster[id] ?? null, asleep: () => false, by: BY, after: timer.after })('claude:atlas', 'tell', hooks, options);
    return { asked, said, timer };
}

describe('a busy agent gets the prompt MID-TURN, and the step does not wait for the turn (Tynn #826)', () => {
    it('Claude mid-turn: delivered into the running turn at once; the step is done while the turn still runs', async () => {
        const a = agent('claude', 'working');
        const { asked, said, timer } = ask(a.port);
        expect(await settledState(asked)).toEqual({ state: 'resolved', value: '' });
        expect(a.midTurn).toEqual([['tell', BY]]);
        expect(a.turns).toEqual([]);
        expect(a.state.turnState).toBe('working');
        expect(said).toEqual([['delivered', expect.stringMatching(/mid-turn/)]]);
        expect(timer.armed()).toBe(0);
    });

    it('Codex mid-turn: accepted, held for the turn end; the step is done without waiting for that turn', async () => {
        const a = agent('codex', 'working');
        const { asked, said, timer } = ask(a.port);
        expect(await settledState(asked)).toEqual({ state: 'resolved', value: '' });
        expect(a.held.map((q) => q.text)).toEqual(['tell']);
        expect(said).toEqual([['accepted', expect.stringMatching(/goes when its current turn ends/)]]);
        expect(timer.armed()).toBe(0);
        a.endTurn('earlier work');
        expect(a.turns).toEqual([['tell', BY]]);
    });

    it('an idle agent: a new turn starts with the prompt; the step is done once delivered, not when the turn ends', async () => {
        const a = agent('claude', 'idle');
        const { asked, said } = ask(a.port);
        expect(await settledState(asked)).toEqual({ state: 'resolved', value: '' });
        expect(a.turns).toEqual([['tell', BY]]);
        expect(a.state.turnState).toBe('working');
        expect(said).toEqual([['delivered', expect.any(String)]]);
    });

    it('CONTROL waitForReply: an idle agent is waited for, and its reply handed on', async () => {
        const a = agent('claude', 'idle');
        const { asked } = ask(a.port, { waitForReply: true });
        expect((await settledState(asked)).state).toBe('pending');
        a.endTurn('done');
        expect(await asked).toBe('done');
    });

    it('waitForReply on a busy Claude agent: delivered mid-turn, then the reply of THAT turn is handed on', async () => {
        const a = agent('claude', 'working');
        const { asked, said } = ask(a.port, { waitForReply: true });
        expect((await settledState(asked)).state).toBe('pending');
        expect(a.midTurn).toEqual([['tell', BY]]);
        a.endTurn('saw it');
        expect(await asked).toBe('saw it');
        expect(a.turns).toEqual([]);
        expect(said.map(([how]) => how)).toEqual(['delivered']);
    });
});

describe('a long wait is not "stuck" while the agent has a background job or is at its limit (Tynn #826)', () => {
    it('waitForReply: a turn waiting 40 minutes on a background job, with nothing new in its ledger, is not cut at 30 minutes', async () => {
        const a = agent('claude', 'idle');
        const { asked, timer } = ask(a.port, { waitForReply: true });
        await tick();
        a.state.background = 1;
        timer.advance(40 * 60_000);
        expect((await settledState(asked)).state).toBe('pending');
        a.state.background = 0;
        a.endTurn('job done');
        expect(await asked).toBe('job done');
        expect(timer.armed()).toBe(0);
    });

    it('CONTROL: the same quiet turn with NO background job is cut at 30 minutes, in words', async () => {
        const a = agent('claude', 'idle');
        const { asked, timer } = ask(a.port, { waitForReply: true });
        await tick();
        timer.advance(FLOW_TURN_QUIET_MS);
        const end = await settledState(asked);
        expect(end.state).toBe('rejected');
        expect(end.state === 'rejected' && end.error.message).toMatch(/atlas's turn did not end: nothing new came from it for 30 minutes/);
    });

    it('waitForReply: a provider limit inside the turn pauses the step; 45 quiet minutes there are not counted', async () => {
        const a = agent('claude', 'idle');
        const { asked, timer } = ask(a.port, { waitForReply: true });
        await tick();
        a.state.limit = { state: 'paused', resumeAtMs: 1 };
        a.state.turnState = 'idle';
        a.notify();
        timer.advance(45 * 60_000);
        expect((await settledState(asked)).state).toBe('pending');
        a.state.limit = { state: 'open' };
        a.endTurn('resumed and done');
        expect(await asked).toBe('resumed and done');
    });
});

describe('a stop, a restart or no run before delivery KEEPS the prompt for the agent\'s next run (Tynn #826)', () => {
    it('an agent not running whose start is refused: the prompt is kept, and the step reads waiting, not failed', async () => {
        const a = agent('claude', 'idle');
        a.state.running = false;
        const { asked, said } = ask(a.port);
        expect(await settledState(asked)).toEqual({ state: 'resolved', value: '' });
        expect(a.kept).toEqual([['agent_atlas', 'tell', BY]]);
        expect(said).toEqual([['waiting', expect.stringMatching(/next runs/)]]);
    });

    it('an agent that stops while the step waits out its provider limit: kept, not failed', async () => {
        const a = agent('claude', 'idle');
        a.state.limit = { state: 'paused', resumeAtMs: 1 };
        const { asked, said } = ask(a.port);
        expect((await settledState(asked)).state).toBe('pending');
        a.stop();
        expect(await settledState(asked)).toEqual({ state: 'resolved', value: '' });
        expect(a.kept).toEqual([['agent_atlas', 'tell', BY]]);
        expect(said.map(([how]) => how)).toEqual(['waiting']);
    });

    it('an idle agent whose prompt is refused as it goes (it stopped): kept, not failed', async () => {
        const a = agent('claude', 'idle');
        a.state.refusePrompt = true;
        const { asked, said } = ask(a.port);
        expect(await settledState(asked)).toEqual({ state: 'resolved', value: '' });
        expect(a.kept).toEqual([['agent_atlas', 'tell', BY]]);
        expect(said.map(([how]) => how)).toEqual(['waiting']);
    });

    it('waitForReply: Codex holds the prompt and the agent stops before the turn ends: the session kept it, the step reads waiting', async () => {
        const a = agent('codex', 'working');
        const { asked, said } = ask(a.port, { waitForReply: true });
        expect((await settledState(asked)).state).toBe('pending');
        a.stop();
        expect(await settledState(asked)).toEqual({ state: 'resolved', value: '' });
        // The session's own stop kept it (owed): keeping it again would send it twice.
        expect(a.kept).toEqual([]);
        expect(said.map(([how]) => how)).toEqual(['accepted', 'waiting']);
    });

    it('CONTROL: a port that cannot keep still fails a prompt with nowhere to go, in words', async () => {
        const a = agent('claude', 'idle', { keep: false });
        a.state.running = false;
        const { asked } = ask(a.port);
        const end = await settledState(asked);
        expect(end.state).toBe('rejected');
        expect(end.state === 'rejected' && end.error.message).toMatch(/atlas is not running/);
    });
});

describe('the next run delivers what was kept (Tynn #826)', () => {
    it('an agent seen running gets its kept flow prompts once; again only after it has stopped and run again', async () => {
        const state = { running: false };
        const listeners = new Set<(id: string) => void>();
        const delivered: string[] = [];
        const port: AgentSessionsPort = {
            session: () => ({ running: state.running, turnState: 'idle' }),
            rows: () => [],
            prompt: () => true,
            subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
            deliverKept: async (id) => { delivered.push(id); return 1; },
        };
        const tell = () => { for (const l of listeners) l('agent_atlas'); };
        const off = deliverKeptOnNextRun(port);
        tell();
        expect(delivered).toEqual([]);
        state.running = true;
        tell();
        tell();
        expect(delivered).toEqual(['agent_atlas']);
        state.running = false;
        tell();
        state.running = true;
        tell();
        expect(delivered).toEqual(['agent_atlas', 'agent_atlas']);
        off();
        state.running = false;
        tell();
        state.running = true;
        tell();
        expect(delivered).toHaveLength(2);
    });
});

describe('the run reads delivered or waiting, never failed (Tynn #826)', () => {
    const user = { kind: 'user' } as const;
    const flowOf = (nodes: unknown[], edges: unknown[] = []): FlowRecord => ({
        id: 'flow_example', workspaceId: WS.id, name: 'nightly report',
        document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes, edges } },
        armed: true, createdBy: user, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', refusals: [], runs: [],
    });
    const trigger = { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } };
    const step = (config: Record<string, unknown>) => ({ id: 's', kind: 'genie/agent_prompt', position: { x: 240, y: 0 }, config: { agent: 'claude:atlas', prompt: 'tell', ...config } });
    const schedule = { nodeId: 't', cron: '0 3 * * *', timezone: undefined };
    const runWith = async (promptAgent: FlowPorts['promptAgent'], config: Record<string, unknown> = {}) => {
        const seen: Array<Record<string, NodeOutcome>> = [];
        const logs: string[] = [];
        const ports = (): FlowPorts => ({ promptAgent, runCommand: async () => ({ exitCode: 0, output: '' }), addKnowledge: async () => ({ id: 'kn' }) });
        const result = await createFlowRunner({ ports, asleep: () => false })(flowOf([trigger, step(config)], [{ id: 't-s', source: 't', target: 's' }]), schedule, { nodes: (o) => seen.push({ ...o }), log: (_n, line) => logs.push(line) });
        return { result, last: seen.at(-1), logs };
    };
    const prompter = (port: AgentSessionsPort) => agentPrompter({ sessions: port, resolve: resolveAddress, agent: (id) => roster[id] ?? null, asleep: () => false, by: BY });

    it('through the runner: a busy agent\'s step reads delivered; the run ran, and its log says mid-turn', async () => {
        const a = agent('claude', 'working');
        const { result, last, logs } = await runWith(prompter(a.port));
        expect(result).toEqual({ outcome: 'ran' });
        expect(last).toMatchObject({ s: 'delivered' });
        expect(logs.join('\n')).toMatch(/mid-turn/);
    });

    it('through the runner: a kept prompt\'s step reads waiting; the run ran', async () => {
        const a = agent('claude', 'idle');
        a.state.running = false;
        const { result, last, logs } = await runWith(prompter(a.port));
        expect(result).toEqual({ outcome: 'ran' });
        expect(last).toMatchObject({ s: 'waiting' });
        expect(logs.join('\n')).toMatch(/next runs/);
    });

    it('the step\'s waitForReply reaches the prompter; a step that waited reads ran', async () => {
        const options: Array<PromptOptions | undefined> = [];
        const { result, last } = await runWith(async (_a, _t, _h, o) => { options.push(o); return 'the reply'; }, { waitForReply: true });
        expect(options).toEqual([{ waitForReply: true }]);
        expect(result).toEqual({ outcome: 'ran' });
        expect(last).toMatchObject({ s: 'ran' });
    });
});
