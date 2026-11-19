import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { statePill } from '../src/core/agent-view.js';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A HUNG TOOL CALL, A HUNG TURN (Tynn #855). Two real cases:
 *   - lift (2026-11-18): a foreground az/gh/git call hung ~21 min; the turn could only be stopped whole.
 *   - prism-engine (2026-11-19): "Turn 14 · running" for hours. Measured: the turn was one Claude started ITSELF after a
 *     background task ended; the CLI ended it (end_turn at 09:34:22Z) but prism-acp 0.43.0 dropped its `result` (no
 *     prompt of Genie's), so no turn end ever came (prism G-313 fixes it with an UNSOLICITED turn end).
 *
 * What these hold, on the session host as genie-host runs it:
 *   - the running call is known by its command and its start (`probe().call`);
 *   - Stop this call ends exactly the processes that call started — never the provider, never what ran before it — and
 *     the agent is told, mid-turn;
 *   - liveness: an exited provider is `dead`, one whose ping never answers is `unresponsive`, one Genie cannot ask is
 *     `unknown` (never guessed alive or dead);
 *   - a turn ended as STALLED is no longer a turn, and the pill says `Stalled · no events for N min`, never Working;
 *   - prism's unsolicited turn end closes the turn Claude started itself.
 */

const P = process.pid;
let t = 1_800_000_000_000;
let table: ProcessInfo[] = [];
let killed: number[] = [];
const tree: ProcessTree = {
    snapshot: () => table.slice(),
    killTree: (targets) => {
        killed.push(...targets.map((p) => p.pid));
        table = table.filter((p) => !targets.some((x) => x.pid === p.pid));
        return { killed: targets.length, refused: false };
    },
};

interface Fake { events: DriverEvents; prompts: string[]; running: boolean; ping?: (timeoutMs: number) => Promise<unknown> }
const fakes = new Map<string, Fake>();

const driverFor: DriverFor = (record) => (options) => {
    const fake: Fake = { events: options.events, prompts: [], running: true };
    fakes.set(record.id, fake);
    return {
        start: () => { table.push({ pid: 100, ppid: P, started: t, name: 'claude' }); },
        prompt: (content: unknown) => { fake.prompts.push(typeof content === 'string' ? content : JSON.stringify(content)); },
        kill: () => {},
        cancel: () => {},
        cliSessionId: null,
        get running() { return fake.running; },
        ping: (timeoutMs: number) => (fake.ping ? fake.ping(timeoutMs) : Promise.reject(new Error('no ping in this fake'))),
    };
};
/** A driver with NO ping: what prism-acp is until G-314. */
const driverWithoutPing: DriverFor = (record) => (options) => {
    const fake: Fake = { events: options.events, prompts: [], running: true };
    fakes.set(record.id, fake);
    return { start: () => { table.push({ pid: 100, ppid: P, started: t, name: 'claude' }); }, prompt: () => {}, kill: () => {}, cancel: () => {}, cliSessionId: null, get running() { return fake.running; } };
};

let dir: string;
let host: SessionHost;
const make = (factory: DriverFor = driverFor): SessionHost => new SessionHost({ userData: dir, driverFor: factory, processTree: tree, clock: () => t });
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-855-'));
    fakes.clear();
    table = [];
    killed = [];
    t = 1_800_000_000_000;
    host = make();
});
afterEach(async () => {
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'lift' });
const fake = (id: AgentId): Fake => fakes.get(id)!;
const update = (id: AgentId, u: Record<string, unknown>): void => { fake(id).events.onUpdate?.(u); };
const MIN = 60_000;

function startInTurn(): AgentRecord {
    const r = record();
    expect(host.start(r, dir)).toEqual({ ok: true });
    // An MCP server the provider started with the session: before any call, never the call's.
    table.push({ pid: 101, ppid: 100, started: t + 500, name: 'node' });
    t += MIN;
    expect(host.prompt(r.id, 'push the branch', 'you')).toBe(true);
    expect(host.inTurn(r.id)).toBe(true);
    return r;
}

function hangBash(id: AgentId, command = 'git push origin feat/x'): void {
    t += 1_000;
    update(id, { sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Bash', title: 'Bash', kind: 'execute', status: 'pending' });
    update(id, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', rawInput: { command } });
    // What the call started: its shell, and what the shell started (the hung git and its credential helper).
    table.push({ pid: 102, ppid: 100, started: t + 200, name: 'bash' });
    table.push({ pid: 103, ppid: 102, started: t + 300, name: 'git' });
}

const notices = (id: AgentId): string[] => host.rowsFor(id).flatMap(({ event }) => (event.kind === 'notice' ? [event.message] : []));

describe('the running call, named (Tynn #855)', () => {
    it('probe() carries the running call: its id, label, command and when it started', () => {
        const r = startInTurn();
        hangBash(r.id);
        const call = host.probe(r.id)!.call;
        expect(call).toEqual({ toolCallId: 't1', label: 'Bash', command: 'git push origin feat/x', since: t });
    });

    it('a completed call is not running; nor is any once the turn has ended', () => {
        const r = startInTurn();
        hangBash(r.id);
        update(r.id, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        expect(host.probe(r.id)!.call).toBeNull();
        hangBash(r.id);
        fake(r.id).events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        expect(host.probe(r.id)!.call).toBeNull();
    });

    it('the time of the last event the provider sent is kept (the seam prism G-314 lastFrameAt can later feed)', () => {
        const r = startInTurn();
        hangBash(r.id);
        const at = t;
        t += 5 * MIN;
        expect(host.probe(r.id)!.lastEventAt).toBe(at);
    });
});

describe('Stop this call (Tynn #855)', () => {
    it('ends exactly what the call started — never the provider, never what ran before it — and the turn goes on', async () => {
        const r = startInTurn();
        hangBash(r.id);
        t += 21 * MIN;
        const result = await host.stopToolCall(r.id, 't1', 'you');
        expect(result).toEqual({ ok: true, ended: 2 });
        expect(killed.sort()).toEqual([102, 103]);
        expect(table.map((p) => p.pid).sort()).toEqual([100, 101]);
        // The turn is still the agent's: only the call ended.
        expect(host.inTurn(r.id)).toBe(true);
    });

    it('the agent is told, in its running turn, which call was ended and why', async () => {
        const r = startInTurn();
        hangBash(r.id);
        t += 21 * MIN;
        await host.stopToolCall(r.id, 't1', 'you');
        await host.settled();
        const told = fake(r.id).prompts.join('\n');
        expect(told).toContain('git push origin feat/x');
        expect(told).toMatch(/Genie ended your tool call/);
        expect(told).toMatch(/the person stopped it/);
        expect(notices(r.id).some((m) => m.includes('git push origin feat/x') && m.includes('21 min'))).toBe(true);
    });

    it('the no-output timeout says so, not that the person did', async () => {
        const r = startInTurn();
        hangBash(r.id);
        t += 15 * MIN;
        await host.stopToolCall(r.id, 't1', 'timeout');
        await host.settled();
        expect(fake(r.id).prompts.join('\n')).toMatch(/no output for 15 min/);
    });

    it('refuses a call that is not running, and one with no process of its own, killing nothing', async () => {
        const r = startInTurn();
        hangBash(r.id);
        expect(await host.stopToolCall(r.id, 'nope', 'you')).toEqual({ ok: false, reason: expect.stringMatching(/not running/) });
        table = table.filter((p) => p.pid !== 102 && p.pid !== 103);
        const none = await host.stopToolCall(r.id, 't1', 'you');
        expect(none.ok).toBe(false);
        expect(killed).toEqual([]);
    });
});

describe('a turn with no call running: is the provider still there? (Tynn #855)', () => {
    it('an exited provider is dead', async () => {
        const r = startInTurn();
        fake(r.id).running = false;
        expect(await host.checkAlive(r.id, 50)).toBe('dead');
    });

    it('a ping that never answers is unresponsive; one that answers is alive', async () => {
        const r = startInTurn();
        fake(r.id).ping = () => new Promise(() => {});
        expect(await host.checkAlive(r.id, 30)).toBe('unresponsive');
        fake(r.id).ping = () => Promise.resolve(true);
        expect(await host.checkAlive(r.id, 30)).toBe('alive');
    });

    it('with no way to ask (no ping), a live process is unknown — never guessed', async () => {
        host.stopAll();
        await host.settled();
        host = make(driverWithoutPing);
        const r = record();
        host.start(r, dir);
        expect(await host.checkAlive(r.id, 30)).toBe('unknown');
    });
});

describe('a turn ended as stalled (Tynn #855)', () => {
    it('is no longer a turn, says so in the chat, and the pill reads Stalled · no events for N min — never running', () => {
        const r = startInTurn();
        t += 21 * MIN;
        expect(host.endStalled(r.id, 'unresponsive', 21 * MIN)).toBe(true);
        const live = host.probe(r.id)!;
        expect(live.inTurn).toBe(false);
        expect(live.turnState).not.toBe('working');
        expect(live.stalled).toEqual({ reason: 'unresponsive', silentMs: 21 * MIN, at: t });
        expect(statePill(live, () => t, { turns: 1 }).word).toBe('Stalled · no events for 21 min');
        expect(notices(r.id).some((m) => /stalled/i.test(m) && m.includes('21 min'))).toBe(true);
    });

    it('the next message clears it', () => {
        const r = startInTurn();
        host.endStalled(r.id, 'dead', 20 * MIN);
        expect(host.prompt(r.id, 'carry on', 'you')).toBe(true);
        expect(host.probe(r.id)!.stalled).toBeNull();
    });

    it('is refused for an agent with no turn in flight', () => {
        const r = record();
        host.start(r, dir);
        expect(host.endStalled(r.id, 'dead', 20 * MIN)).toBe(false);
    });
});

describe('prism G-313: the unsolicited turn end closes the turn Claude started itself', () => {
    it('a self-started turn ends on an outcome that names no prompt of Genie\'s', () => {
        const r = startInTurn();
        fake(r.id).events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        expect(host.inTurn(r.id)).toBe(false);
        // A background task ended: Claude starts a turn of its own.
        update(r.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The fuzz job passed on both.' } });
        expect(host.inTurn(r.id)).toBe(true);
        fake(r.id).events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null, unsolicited: true });
        expect(host.inTurn(r.id)).toBe(false);
        expect(host.probe(r.id)!.turnState).not.toBe('working');
    });
});
