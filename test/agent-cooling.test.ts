import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statePill } from '../src/core/agent-view.js';
import { chatContext } from '../src/core/chat-view.js';
import { groupByStatus, groupByWorkspace, statusOf, summaryChips, type AgentRow } from '../src/core/dashboard-view.js';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { workingAgents } from '../src/core/rail-indicators.js';
import { agentRowFor } from '../src/core/roster.js';
import { COOLING_MS, type DriverEvents, type SessionDriverFactory, type TurnOutcomeLike } from '../src/core/session.js';
import { agentPrompter, type AgentSessionsPort } from '../src/main/flow-runner.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * COOLING (the owner, 2026-11-01): "a state they enter right after finishing a turn (coming out of the work state).
 * Instead of immediately marking them as idle, they are "Cooling" down for 15 seconds then become Idle. This way I can
 * sort By status and agents that are in between turns aren't making the whole list jump around. Cooling is treated the
 * same as Working in terms of how the dashboard list is sorted."
 *
 * Cooling is a status for DISPLAY and SORTING. It changes nothing an agent can do: `turnState` stays `idle`, and every
 * reader that decides whether to prompt (the inbox push, a flow, the person's message, a setting) reads what it read
 * before. Each negative assertion below sits beside a positive control in the same run.
 */

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

interface Fake { events: DriverEvents; prompts: string[] }
const fakes = new Map<string, Fake>();

const driverFor: DriverFor = (record) => {
    if (record.provider !== 'claude') return null;
    const factory: SessionDriverFactory = (options) => {
        const fake: Fake = { events: options.events, prompts: [] };
        fakes.set(record.id, fake);
        return { start: () => {}, prompt: (content: unknown) => { fake.prompts.push(String(content)); }, kill: () => {}, cancel: () => {}, cliSessionId: null };
    };
    return factory;
};

let dir: string;
let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-cooling-'));
    fakes.clear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
});
afterEach(async () => {
    // Anything still pending on the fake clock (a Cooling wait, a store's lock retry) runs now, so nothing waits forever.
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (name = 'atlas'): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'pa', provider: 'claude', name });
const now = () => 1_760_000_024_000;
const endTurn = (id: AgentId, outcome: TurnOutcomeLike = { stopReason: 'end_turn', isError: false, raw: null }) => fakes.get(id)!.events.onTurnEnd?.(outcome);
const rowOf = (r: AgentRecord) => agentRowFor(r, host.probe(r.id), now);
/** Started and one turn of the person's run, still running. */
const working = (r: AgentRecord): void => {
    expect(host.start(r, dir)).toEqual({ ok: true });
    expect(host.prompt(r.id, 'go', 'you')).toBe(true);
    expect(rowOf(r).state).toBe('working');
};

describe('a turn that ends cleanly', () => {
    it('is fifteen seconds, one named constant', () => {
        expect(COOLING_MS).toBe(15_000);
    });

    it('reads Cooling for 15 s, then Idle — and the move to Idle is announced', () => {
        const r = record();
        working(r);
        endTurn(r.id);
        expect(host.probe(r.id)?.turnState).toBe('idle');
        expect(host.probe(r.id)?.cooling).toBe(true);
        expect(rowOf(r).state).toBe('cooling');
        expect(statusOf(rowOf(r)).word).toBe('Cooling');

        const seen: string[] = [];
        const off = host.subscribe((id) => { if (id === r.id) seen.push(rowOf(r).state); });
        vi.advanceTimersByTime(COOLING_MS - 1);
        expect(rowOf(r).state).toBe('cooling');
        expect(seen).toEqual([]);
        vi.advanceTimersByTime(1);
        off();
        expect(host.probe(r.id)?.cooling).toBe(false);
        expect(rowOf(r).state).toBe('idle');
        expect(statusOf(rowOf(r)).word).toBe('Idle');
        // Pushed, so the board, the remote and the phone redraw it without waiting for another row.
        expect(seen).toEqual(['idle']);
    });

    it('a new turn during Cooling goes straight to Working and cancels the timer', () => {
        const r = record();
        working(r);
        endTurn(r.id);
        expect(rowOf(r).state).toBe('cooling');
        vi.advanceTimersByTime(5_000);
        expect(host.prompt(r.id, 'and again', 'you')).toBe(true);
        expect(host.probe(r.id)?.cooling).toBe(false);
        expect(rowOf(r).state).toBe('working');
        // The old timer is gone: past its 15 s the turn still reads Working, and nothing announced it Idle.
        const seen: string[] = [];
        const off = host.subscribe((id) => { if (id === r.id) seen.push(rowOf(r).state); });
        vi.advanceTimersByTime(COOLING_MS);
        off();
        expect(rowOf(r).state).toBe('working');
        expect(seen).toEqual([]);
        // That turn ending cools afresh, for a full 15 s from ITS end.
        endTurn(r.id);
        vi.advanceTimersByTime(COOLING_MS - 1);
        expect(rowOf(r).state).toBe('cooling');
        vi.advanceTimersByTime(1);
        expect(rowOf(r).state).toBe('idle');
    });

    it('a turn the agent starts itself during Cooling (its own activity) is Working too', () => {
        const r = record();
        working(r);
        endTurn(r.id);
        expect(rowOf(r).state).toBe('cooling');
        fakes.get(r.id)!.events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a subagent reported' } });
        expect(host.probe(r.id)?.cooling).toBe(false);
        expect(rowOf(r).state).toBe('working');
    });

    it('stopping the agent during Cooling clears it: no timer outlives the run', () => {
        const r = record();
        working(r);
        endTurn(r.id);
        expect(rowOf(r).state).toBe('cooling');
        void host.stop(r.id);
        expect(host.probe(r.id)?.cooling ?? false).toBe(false);
        expect(rowOf(r).state).not.toBe('cooling');
    });
});

describe('a turn that does not end cleanly never shows Cooling', () => {
    it('a failed turn is Broken at once', () => {
        const r = record();
        working(r);
        endTurn(r.id, { stopReason: null, isError: true, raw: 'stream closed' });
        expect(host.probe(r.id)?.cooling).toBe(false);
        expect(rowOf(r).state).toBe('broken');
    });

    it('a turn the person stopped is Idle at once', () => {
        const r = record();
        working(r);
        endTurn(r.id, { stopReason: 'cancelled', isError: false, raw: null });
        expect(host.probe(r.id)?.cooling).toBe(false);
        expect(rowOf(r).state).toBe('idle');
    });

    it('a turn ended by the rate limit is held, not Cooling', () => {
        const r = record();
        working(r);
        endTurn(r.id, { stopReason: null, isError: true, raw: null, failure: { kind: 'rate_limit', reason: 'limit' } } as TurnOutcomeLike);
        expect(host.probe(r.id)?.cooling).toBe(false);
        expect(rowOf(r).state).toBe('idle');
    });

    it('an approval parked on the person reads Waiting on you, never Cooling', () => {
        // An agent set to ask before shell commands: its request parks on the person.
        const r: AgentRecord = { ...record(), permissions: 'ask' };
        working(r);
        endTurn(r.id);
        expect(rowOf(r).state).toBe('cooling');
        void fakes.get(r.id)!.events.onRequestPermission?.({ toolCall: { title: 'rm -rf build' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
        expect(rowOf(r).state).toBe('waiting');
    });
});

describe('Cooling changes nothing the agent can do', () => {
    it('the session is as promptable and deliverable as an idle one', () => {
        const r = record();
        working(r);
        // POSITIVE CONTROL: mid-turn it is not promptable.
        expect(host.promptable(r.id)).toBeNull();
        endTurn(r.id);
        expect(rowOf(r).state).toBe('cooling');
        expect(host.promptable(r.id)).not.toBeNull();
        expect(host.deliverable(r.id)).not.toBeNull();
        expect(host.probe(r.id)?.turnState).toBe('idle');
    });

    it('a flow prompt to a Cooling agent is delivered at once, and its turn ending answers at once — not after the cooling', async () => {
        const r = record();
        working(r);
        endTurn(r.id);
        expect(rowOf(r).state).toBe('cooling');
        const sessions: AgentSessionsPort = {
            session: (id) => host.probe(id as AgentId),
            rows: (id) => host.rowsFor(id as AgentId),
            prompt: (id, text, by) => host.prompt(id as AgentId, text, by),
            subscribe: (listener) => host.subscribe((agentId) => listener(agentId)),
        };
        const prompt = agentPrompter({ sessions, resolve: () => ({ kind: 'one', id: r.id }), agent: () => ({ name: 'atlas', workspaceId: 'pa' }), asleep: () => false, by: 'flow "nightly"' });
        let answer: string | null = null;
        const replied = prompt('claude:atlas', 'check the queue').then((a) => { answer = a; return a; });
        // Not held back as busy: the provider has it now.
        expect(fakes.get(r.id)!.prompts).toEqual(['go', 'check the queue']);
        expect(rowOf(r).state).toBe('working');
        fakes.get(r.id)!.events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'queue is empty' } });
        endTurn(r.id);
        // Cooling again, and the flow already has its answer: no timer was needed for it.
        expect(rowOf(r).state).toBe('cooling');
        expect(await replied).toBe('queue is empty');
        expect(answer).toBe('queue is empty');
        expect(rowOf(r).state).toBe('cooling');
    });
});

describe('where Cooling shows', () => {
    it('the Agent view header and the chat line say Cooling, then Idle', () => {
        const r = record();
        working(r);
        endTurn(r.id);
        const chat = () => chatContext({ agent: { id: r.id, name: r.name, provider: r.provider, fidelity: 'declared' }, session: host.probe(r.id), rows: [] });
        expect(statePill(host.probe(r.id), now, { turns: 1 }).word).toBe('Cooling');
        expect(chat().text).toBe('Cooling');
        vi.advanceTimersByTime(COOLING_MS);
        expect(statePill(host.probe(r.id), now, { turns: 1 }).word).toBe('Idle');
        expect(chat().text).toBe('Idle');
    });

    it('a colour of its own: not Working’s, not Idle’s', () => {
        const base = rowFixture('a', 'working');
        const tones = new Set([statusOf(base).tone, statusOf({ ...base, state: 'idle' }).tone]);
        expect(tones.has(statusOf({ ...base, state: 'cooling' }).tone)).toBe(false);
    });

    it('the remote and the phone: the probe crosses the wire as JSON and still reads Cooling', () => {
        const r = record();
        working(r);
        endTurn(r.id);
        // What a remote host sends and the phone's bridge relays: the probe, serialised.
        const wire = JSON.parse(JSON.stringify(host.probe(r.id))) as ReturnType<SessionHost['probe']>;
        const row = agentRowFor(r, wire, now);
        expect(row.state).toBe('cooling');
        // The phone draws `statusOf` and `summaryChips` (MobileShell's AgentsSection).
        expect(statusOf(JSON.parse(JSON.stringify(row)) as AgentRow).word).toBe('Cooling');
    });
});

function rowFixture(id: string, state: AgentRow['state'], workspaceId = 'pa'): AgentRow {
    return {
        id, name: id, provider: 'claude', workspaceId, fidelity: 'declared', state, duration: null, ask: null, reason: null, fixes: [],
        step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
    };
}

describe('sorting: Cooling is Working, so a turn ending moves nothing', () => {
    // Four agents, one of them between turns. Every order is read before and after its turn ends.
    const before: AgentRow[] = [rowFixture('w1', 'working'), rowFixture('idle1', 'idle'), rowFixture('mid', 'working'), rowFixture('w2', 'working')];
    const after: AgentRow[] = before.map((r) => (r.id === 'mid' ? { ...r, state: 'cooling' } : r));
    const later: AgentRow[] = before.map((r) => (r.id === 'mid' ? { ...r, state: 'idle' } : r));
    const ids = (rows: readonly AgentRow[]) => rows.map((r) => r.id);

    it('By status: a Cooling agent stays in the Working group, in its place', () => {
        const groups = (rows: readonly AgentRow[]) => groupByStatus(rows).map((g) => [g.label, ids(g.rows)]);
        expect(groups(before)).toEqual([['Working', ['w1', 'mid', 'w2']], ['Idle', ['idle1']]]);
        expect(groups(after)).toEqual(groups(before));
        // POSITIVE CONTROL: Idle, 15 s later, is the one move.
        expect(groups(later)).toEqual([['Working', ['w1', 'w2']], ['Idle', ['idle1', 'mid']]]);
    });

    it('By workspace: the same rank as Working, so the row keeps its place', () => {
        const order = (rows: readonly AgentRow[]) => ids(groupByWorkspace(rows, ['pa'])[0]!.rows);
        expect(order(after)).toEqual(order(before));
        expect(order(later)).not.toEqual(order(before));
    });

    it('the counts: Cooling is counted with Working — the header chips (desktop and phone) and the rail', () => {
        expect(summaryChips(after).map((c) => c.label)).toEqual(['3 working', '1 idle']);
        expect(summaryChips(after)).toEqual(summaryChips(before));
        expect(summaryChips(later).map((c) => c.label)).toEqual(['2 working', '2 idle']);
        expect(workingAgents(after, 'pa')).toBe(3);
        expect(workingAgents(later, 'pa')).toBe(2);
    });
});
