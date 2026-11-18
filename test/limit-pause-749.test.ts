import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { NodeOutcome } from '../src/core/flow-canvas.js';
import type { Resolution } from '../src/core/inbox.js';
import type { FlowPorts } from '../src/main/flow-executors.js';
import { createFlowRunner, type AgentSessionsPort } from '../src/main/flow-runner.js';
import { waitingPrompter } from './helpers/waiting-prompter.js';
import type { FlowRecord } from '../src/main/flow-store.js';

/**
 * TYNN #749, DIAGNOSIS (RED ON PURPOSE): a rate limit must be a PAUSE for a flow lane, never a loss. These tests state the
 * wanted behaviour and FAIL today; each failure is one thing that is lost now.
 *
 * The agent side already holds a limit-cut agent (core/session.ts `byLimit` -> `#held`, turnState 'idle', never 'failed'),
 * and resumes it with a nudge turn at the reset (`resumeAfterLimit`). The flow side (`agentPrompter`, main/flow-runner.ts)
 * never looks at the limit: it reads "turn ended, agent idle" as "step done", and a held agent as "turn never began".
 *
 * The stub is the host's own port shape (probe() output: running, turnState 'idle' while held, `limit` = the gate's view
 * from session-host.ts `#limitOf`), driven by a hand timer: nothing waits on a real clock.
 */

const IDS = ['agent_a', 'agent_b', 'agent_c'] as const;
type Id = (typeof IDS)[number];
const resolve = (text: string): Resolution => {
    const m = /^claude:(a|b|c)$/.exec(text);
    return m ? { kind: 'one', id: `agent_${m[1]}` as never } : { kind: 'none' };
};

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
    };
}

/** Agents as the host's probe reports them, with the held queue a limited session keeps (`AgentSession.#queuePrompt`). */
function farm() {
    const st = Object.fromEntries(IDS.map((id) => [id, { running: true, turnState: 'idle', pendingApproval: null as unknown, limit: { state: 'open' } as { state: string } }])) as Record<Id, { running: boolean; turnState: string; pendingApproval: unknown; limit: { state: string } }>;
    const rows = Object.fromEntries(IDS.map((id) => [id, [] as Array<{ event: unknown }>])) as Record<Id, Array<{ event: unknown }>>;
    const held = Object.fromEntries(IDS.map((id) => [id, false])) as Record<Id, boolean>;
    /** The limit cut this agent's turn: only then does the reset send the nudge turn (session.ts `#cutByLimit`; an idle held agent is told nothing, Tynn #543). */
    const cut = Object.fromEntries(IDS.map((id) => [id, false])) as Record<Id, boolean>;
    const waiting = Object.fromEntries(IDS.map((id) => [id, [] as Array<{ text: string; by: string }>])) as Record<Id, Array<{ text: string; by: string }>>;
    const listeners = new Set<(id: string) => void>();
    const tell = (id: Id) => { for (const l of listeners) l(id); };
    const begin = (id: Id, by: string) => { rows[id].push({ event: { kind: 'turn', by } }); st[id].turnState = 'working'; };
    const port: AgentSessionsPort = {
        session: (id) => st[id as Id] as never,
        rows: (id) => rows[id as Id],
        // session-host.ts `prompt`: a held session QUEUES the prompt and the caller is told true (handOff !== null).
        prompt: (id, text, by) => {
            const a = id as Id;
            if (held[a]) { waiting[a].push({ text, by }); return true; }
            begin(a, by);
            return true;
        },
        subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
    return {
        port, st, rows, waiting,
        /** The provider's limit ends the agent's turn: what it had said stays, the session is held and reads idle (session.ts byLimit). */
        cutByLimit(id: Id, partial: string) {
            if (partial) rows[id].push({ event: { kind: 'message', speaker: 'agent', peerName: null, text: partial } });
            st[id].turnState = 'idle';
            held[id] = true;
            cut[id] = true;
            st[id].limit = { state: 'paused' };
            tell(id);
        },
        /** A held agent that has not been prompted yet is already at the limit (its login's reading holds it). */
        holdIdle(id: Id) { held[id] = true; st[id].limit = { state: 'paused' }; tell(id); },
        /** The reset: what waited goes out as a turn, else the nudge turn (session.ts resumeAfterLimit). */
        reset(id: Id) {
            held[id] = false;
            st[id].limit = { state: 'open' };
            const next = waiting[id].shift();
            if (next) begin(id, next.by);
            else if (cut[id]) begin(id, 'genie');
            cut[id] = false;
            tell(id);
        },
        finish(id: Id, said: string) {
            rows[id].push({ event: { kind: 'message', speaker: 'agent', peerName: null, text: said } });
            st[id].turnState = 'idle';
            tell(id);
        },
        /** The agent's session ends (stopped, crashed). */
        stop(id: Id) { st[id].running = false; tell(id); },
        /** A turn that failed for any other reason: Broken. */
        fail(id: Id) { st[id].turnState = 'failed'; tell(id); },
        /** Its turn is under way before any limit. */
        working(id: Id, by = 'flow') { begin(id, by); tell(id); },
    };
}

type Settled = { state: 'pending' } | { state: 'resolved'; value: unknown } | { state: 'rejected'; error: Error };
async function settledState(p: Promise<unknown>): Promise<Settled> {
    let out: Settled = { state: 'pending' };
    p.then((value) => { out = { state: 'resolved', value }; }, (error: Error) => { out = { state: 'rejected', error }; });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    return out;
}
const delivered = () => new Promise<void>((r) => setTimeout(r, 0));
const HOUR = 60 * 60_000;

const prompterOf = (port: AgentSessionsPort, timer: ReturnType<typeof handTimer>) =>
    waitingPrompter({ sessions: port, resolve, agent: (id) => ({ name: id.replace('agent_', ''), workspaceId: 'ws' }), asleep: () => false, by: 'flow "nightly"', after: timer.after });

describe('#749 a flow step whose agent hits the provider limit mid-turn', () => {
    it('is NOT finished by the limit: the cut turn is not the step\'s answer, so the step keeps waiting', async () => {
        const f = farm();
        const timer = handTimer();
        const asked = prompterOf(f.port, timer)('claude:a', 'Write the report');
        await delivered();
        f.cutByLimit('agent_a', 'Section 1 of the rep');
        const r = await settledState(asked);
        // TODAY: resolved with the partial text, so the next step runs on half an answer and the run reads "ran".
        expect(r.state).toBe('pending');
    });

    it('continues the SAME step after the reset, however long the wait: its output is the resumed turn\'s whole answer, and the wait does not count against the 2 hour bound', async () => {
        const f = farm();
        const timer = handTimer();
        const asked = prompterOf(f.port, timer)('claude:a', 'Write the report');
        await delivered();
        f.cutByLimit('agent_a', 'Section 1 of the rep');
        await delivered(); // the prompter's own awaits run: a step the limit finished would be settled here, before the reset
        timer.advance(3 * HOUR); // the five-hour window: longer than FLOW_TURN_MAX_MS and FLOW_TURN_QUIET_MS
        f.reset('agent_a');
        f.finish('agent_a', 'Section 2 and the end.');
        const r = await settledState(asked);
        expect(r.state).toBe('resolved');
        expect(r.state === 'resolved' && String(r.value)).toContain('Section 2 and the end.');
    });

    it('CONTROL: a turn that failed for another reason still FAILS the step', async () => {
        const f = farm();
        const timer = handTimer();
        const asked = prompterOf(f.port, timer)('claude:a', 'Write the report');
        await delivered();
        f.fail('agent_a');
        const r = await settledState(asked);
        expect(r.state).toBe('rejected');
    });
});

describe('#749 a flow step prompting an agent that is ALREADY held at the limit', () => {
    it('waits for the reset instead of failing at the quiet half hour', async () => {
        const f = farm();
        const timer = handTimer();
        f.holdIdle('agent_a');
        const asked = prompterOf(f.port, timer)('claude:a', 'Write the report');
        await delivered();
        timer.advance(31 * 60_000);
        const r = await settledState(asked);
        // TODAY: rejected "turn did not end: nothing new came from it for 30 minutes" - the lane is dumped while the agent is merely paused.
        expect(r.state).toBe('pending');
    });

    it('finishes after the reset: the held prompt goes as its turn and the step takes that reply', async () => {
        const f = farm();
        const timer = handTimer();
        f.holdIdle('agent_a');
        const asked = prompterOf(f.port, timer)('claude:a', 'Write the report');
        await delivered();
        timer.advance(3 * HOUR);
        f.reset('agent_a');
        await delivered(); // the held agent is idle again: the step's prompt goes now, as its own turn
        f.finish('agent_a', 'The report.');
        const r = await settledState(asked);
        expect(r.state).toBe('resolved');
        expect(r.state === 'resolved' && String(r.value)).toBe('The report.');
    });

    it('a step that really fails (its agent stopped while it waited) leaves NO prompt in the agent queue: it would run later as a turn nobody waits for', async () => {
        const f = farm();
        const timer = handTimer();
        f.holdIdle('agent_a');
        const asked = prompterOf(f.port, timer)('claude:a', 'Write the report');
        const gone = asked.then(() => null, (e: unknown) => e);
        await delivered();
        f.stop('agent_a');
        expect(await gone).toBeInstanceOf(Error);
        // TODAY: the prompt was handed to the held agent at once and still waits in its queue; `reset` would start it as an orphan turn.
        expect(f.waiting.agent_a).toEqual([]);
    });
});

describe('#749 three lanes, one of them limited (the story\'s acceptance)', () => {
    it('all three finish after the reset with no lost step; the limited lane\'s output is its whole answer', async () => {
        const f = farm();
        const timer = handTimer();
        const prompter = prompterOf(f.port, timer);
        const lanes = [prompter('claude:a', 'lane A'), prompter('claude:b', 'lane B'), prompter('claude:c', 'lane C')];
        await delivered();
        f.cutByLimit('agent_b', 'B: half of it');
        f.finish('agent_a', 'A done');
        f.finish('agent_c', 'C done');
        await delivered();
        timer.advance(3 * HOUR);
        f.reset('agent_b');
        f.finish('agent_b', 'B: the rest');
        const out = await Promise.all(lanes.map(settledState));
        expect(out.map((o) => o.state)).toEqual(['resolved', 'resolved', 'resolved']);
        expect(out[0]!.state === 'resolved' && out[0]!.value).toBe('A done');
        expect(out[2]!.state === 'resolved' && out[2]!.value).toBe('C done');
        expect(out[1]!.state === 'resolved' && String(out[1]!.value)).toContain('B: the rest');
    });
});

describe('#749 a REAL flow run (fancy-flow, createFlowRunner): steps run one after another, so a paused step holds the run, never fails it', () => {
    const user = { kind: 'user' } as const;
    const flow: FlowRecord = {
        id: 'flow_example', workspaceId: 'ws', name: 'nightly',
        document: {
            $schema: FLOW_SCHEMA_URL, version: 1,
            graph: {
                nodes: [
                    { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } },
                    { id: 's1', kind: 'genie/agent_prompt', position: { x: 200, y: 0 }, config: { agent: 'claude:a', prompt: 'lane A' } },
                    { id: 's2', kind: 'genie/agent_prompt', position: { x: 400, y: 0 }, config: { agent: 'claude:b', prompt: 'lane B' } },
                    { id: 's3', kind: 'genie/agent_prompt', position: { x: 600, y: 0 }, config: { agent: 'claude:c', prompt: 'lane C' } },
                ],
                edges: [{ id: 'e1', source: 't', target: 's1' }, { id: 'e2', source: 's1', target: 's2' }, { id: 'e3', source: 's2', target: 's3' }],
            },
        },
        armed: true, createdBy: user, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', refusals: [], runs: [],
    };
    const schedule = { nodeId: 't', cron: '0 3 * * *', timezone: undefined };

    it('step 2 hits the limit: the run shows it PAUSED (not failed), keeps its place, and finishes all three steps after the reset', async () => {
        const f = farm();
        const timer = handTimer();
        const seen: Array<Record<string, NodeOutcome>> = [];
        const ports = (): FlowPorts => ({ promptAgent: prompterOf(f.port, timer), runCommand: async () => ({ exitCode: 0, output: '' }), addKnowledge: async () => ({ id: 'kn' }) });
        const running = createFlowRunner({ ports, asleep: () => false })(flow, schedule, { nodes: (o) => seen.push({ ...o }) });
        await delivered();
        f.finish('agent_a', 'A done');
        await delivered();
        f.cutByLimit('agent_b', 'B: half of it');
        await delivered();
        // TODAY: step 2 "ran" on half an answer, step 3 started, and the run went on without it.
        expect(seen.at(-1)).toMatchObject({ s1: 'ran', s2: 'paused', s3: 'not reached' });
        timer.advance(3 * HOUR);
        await delivered();
        expect(seen.at(-1)).toMatchObject({ s2: 'paused', s3: 'not reached' });
        f.reset('agent_b');
        f.finish('agent_b', 'B: the rest');
        await delivered();
        f.finish('agent_c', 'C done');
        expect(await running).toEqual({ outcome: 'ran' });
        expect(seen.at(-1)).toMatchObject({ s1: 'ran', s2: 'ran', s3: 'ran' });
    });
});
