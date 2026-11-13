import { describe, expect, it } from 'vitest';
import type { Resolution } from '../src/core/inbox.js';
import { FLOW_TURN_MAX_MS, FLOW_TURN_QUIET_MS, agentPrompter, type AgentSessionsPort } from '../src/main/flow-runner.js';

/**
 * A FLOW NEVER WAITS FOR EVER ON AN AGENT'S TURN (Tynn #684, genie#721).
 *
 * `genie/agent_prompt` waits for the agent's turn to end, because its reply is the step's output (kept with the run, read
 * by the steps after it) and a step after it runs after the agent's work, not beside it. That wait had no bound: when the
 * turn's end never reached Genie (the root cause is fixed in the session, test/turn-end-held-684.test.ts), the run never
 * ended, and the scheduler held every later run back as "the previous run is still going" for 11 hours.
 *
 * The bound is a safety net, not the fix: the wait ends when the agent has shown NO sign of life (no new ledger row) for
 * FLOW_TURN_QUIET_MS, or at FLOW_TURN_MAX_MS whatever it shows. The run then fails in words, and the next run is the next
 * chance. Driven by a hand timer: nothing here waits on a real clock.
 */

const AGENT = 'agent_scout';
const resolve = (text: string): Resolution => (text === 'claude:scout' ? { kind: 'one', id: AGENT as never } : { kind: 'none' });

function handTimer() {
    let clock = 0;
    const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
    return {
        after(ms: number, fn: () => void) {
            const t = { at: clock + ms, fn, cancelled: false };
            timers.push(t);
            return () => { t.cancelled = true; };
        },
        /** Let `ms` pass: every timer due by then fires, in order. */
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

function liveAgent() {
    let turnState = 'idle';
    const rows: Array<{ event: unknown }> = [];
    const listeners = new Set<(id: string) => void>();
    const port: AgentSessionsPort = {
        session: () => ({ running: true, turnState, pendingApproval: null }),
        rows: () => rows,
        prompt: () => { turnState = 'working'; rows.push({ event: { kind: 'turn', n: 1, by: 'flow' } }); return true; },
        subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
    const tell = () => { for (const l of listeners) l(AGENT); };
    return {
        port,
        /** A sign of life: a tool call, a thought, a line of its reply. */
        activity: () => { rows.push({ event: { kind: 'tool', name: 'Bash' } }); tell(); },
        finish: (said: string) => { rows.push({ event: { kind: 'message', speaker: 'agent', peerName: null, text: said } }); turnState = 'idle'; tell(); },
    };
}

async function settledState(p: Promise<unknown>): Promise<{ state: 'pending' } | { state: 'resolved'; value: unknown } | { state: 'rejected'; error: Error }> {
    let out: { state: 'pending' } | { state: 'resolved'; value: unknown } | { state: 'rejected'; error: Error } = { state: 'pending' };
    p.then((value) => { out = { state: 'resolved', value }; }, (error: Error) => { out = { state: 'rejected', error }; });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    return out;
}

/** The prompt is handed over and the wait has begun (the prompter's own awaits are behind it). */
const delivered = () => new Promise<void>((r) => setTimeout(r, 0));

const prompter = (port: AgentSessionsPort, timer: ReturnType<typeof handTimer>) =>
    agentPrompter({ sessions: port, resolve, agent: () => ({ name: 'scout', workspaceId: 'ws' }), asleep: () => false, by: 'flow "hourly round"', after: timer.after });

describe('the bound', () => {
    it('is a quiet half hour, within two hours at most: longer than a turn that is working, shorter than a day of held runs', () => {
        expect(FLOW_TURN_QUIET_MS).toBe(30 * 60_000);
        expect(FLOW_TURN_MAX_MS).toBe(2 * 60 * 60_000);
    });
});

describe('a turn that never ends', () => {
    it('ends the wait after a quiet half hour, in words, and the next run is the next chance', async () => {
        const agent = liveAgent();
        const timer = handTimer();
        const asked = prompter(agent.port, timer)('claude:scout', 'Hourly round');
        await delivered();
        timer.advance(FLOW_TURN_QUIET_MS - 1);
        expect((await settledState(asked)).state).toBe('pending');
        timer.advance(1);
        const end = await settledState(asked);
        expect(end.state).toBe('rejected');
        expect(end.state === 'rejected' && end.error.message).toBe("scout's turn did not end: nothing new came from it for 30 minutes. The flow stopped waiting for it; the next run will try again.");
        // Nothing left armed to fire later.
        expect(timer.armed()).toBe(0);
    });

    it('LIVENESS: a turn still working (new rows) is not cut at a quiet half hour, and is cut at two hours', async () => {
        const agent = liveAgent();
        const timer = handTimer();
        const asked = prompter(agent.port, timer)('claude:scout', 'Hourly round');
        await delivered();
        for (let minutes = 20; minutes < 120; minutes += 20) {
            timer.advance(20 * 60_000);
            agent.activity();
            expect((await settledState(asked)).state).toBe('pending');
        }
        timer.advance(20 * 60_000);
        const end = await settledState(asked);
        expect(end.state).toBe('rejected');
        expect(end.state === 'rejected' && end.error.message).toBe("scout's turn did not end within 2 hours. The flow stopped waiting for it; the next run will try again.");
        expect(timer.armed()).toBe(0);
    });
});

describe('CONTROL: a turn that ends is answered as before', () => {
    it('ending at 29 minutes answers with its reply, and leaves no timer behind', async () => {
        const agent = liveAgent();
        const timer = handTimer();
        const asked = prompter(agent.port, timer)('claude:scout', 'Hourly round');
        await delivered();
        timer.advance(29 * 60_000);
        agent.finish('round done');
        expect(await asked).toBe('round done');
        expect(timer.armed()).toBe(0);
        timer.advance(FLOW_TURN_MAX_MS);
    });
});
