import { describe, expect, it, vi } from 'vitest';
import { statePill } from '../src/core/agent-view.js';
import { statusOf } from '../src/core/dashboard-view.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { runningCallWords, stalledWords, stallNoticeText, toolTimeoutMsFrom, STALLED_DECK_PREFIX, StalledTurnBook } from '../src/core/hung-call.js';
import { AGENT_SCOPED_METHODS, REMOTE_METHODS, capabilityOf } from '../src/core/remote-protocol.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';
import { SETTINGS } from '../src/core/settings.js';
import { resolveDeckAnswer } from '../src/core/deck-resolve.js';
import { TurnStallWatchdog, type RunningCall, type StallState } from '../src/core/turn-stall.js';

/**
 * Tynn #855, the parts with no session: the watchdog's three rules (name the call, end a call with no output for the
 * timeout, check a silent turn with no call), the words the person reads, the setting, the Deck item, the protocol.
 */

const MIN = 60_000;
const call: RunningCall = { toolCallId: 't1', label: 'Bash', command: 'az login --use-device-code', since: 0 };

function watchdog(over: { state?: Partial<StallState>; toolTimeoutMs?: number; verdict?: 'alive' | 'dead' | 'unresponsive' | 'unknown' } = {}) {
    let now = 0;
    const state: StallState = { inTurn: true, mode: 'manual', waitingOnPerson: false, call: null, ...over.state };
    const ports = {
        now: () => now,
        stallMs: () => 20 * MIN,
        toolTimeoutMs: () => over.toolTimeoutMs ?? 15 * MIN,
        agents: () => ['a'],
        read: () => state,
        flag: vi.fn(),
        nudge: vi.fn(),
        endCall: vi.fn(),
        checkAlive: vi.fn(async () => over.verdict ?? 'alive'),
        stall: vi.fn(),
    };
    const w = new TurnStallWatchdog(ports);
    return { w, ports, state, at: (ms: number) => { now = ms; } };
}

describe('the watchdog names the running call (Tynn #855)', () => {
    it('the flag carries the call', async () => {
        const { w, ports, at } = watchdog({ state: { call }, toolTimeoutMs: 0 });
        await w.check();
        at(20 * MIN);
        await w.check();
        expect(ports.flag).toHaveBeenCalledWith('a', 20 * MIN, call);
    });

    it('the notice says the command and its age, and that Stop this call ends just that call', () => {
        const text = stallNoticeText(21 * MIN, call, 21 * MIN);
        expect(text).toContain('no output for 21 minutes');
        expect(text).toContain('az login --use-device-code');
        expect(text).toContain('started 21 min ago');
        expect(text).toMatch(/Stop this call/);
    });

    it('with no call running the notice says so', () => {
        expect(stallNoticeText(20 * MIN, null, 20 * MIN)).toMatch(/no tool call is running/);
    });
});

describe('the no-output timeout ends a hung foreground call (Tynn #855)', () => {
    it('a call silent for the timeout is ended once and the agent is told (by endCall)', async () => {
        const { w, ports, at } = watchdog({ state: { call } });
        await w.check();
        at(14 * MIN);
        await w.check();
        expect(ports.endCall).not.toHaveBeenCalled();
        at(15 * MIN);
        await w.check();
        expect(ports.endCall).toHaveBeenCalledWith('a', 't1', 15 * MIN);
        at(16 * MIN);
        await w.check();
        expect(ports.endCall).toHaveBeenCalledTimes(1);
    });

    it('output re-arms it; 0 = never', async () => {
        const { w, ports, at } = watchdog({ state: { call } });
        await w.check();
        at(10 * MIN);
        w.activity('a');
        at(15 * MIN);
        await w.check();
        expect(ports.endCall).not.toHaveBeenCalled();
        at(25 * MIN);
        await w.check();
        expect(ports.endCall).toHaveBeenCalledTimes(1);

        const off = watchdog({ state: { call }, toolTimeoutMs: 0 });
        await off.w.check();
        off.at(120 * MIN);
        await off.w.check();
        expect(off.ports.endCall).not.toHaveBeenCalled();
    });

    it('never while the agent waits on the person', async () => {
        const { w, ports, at } = watchdog({ state: { call, waitingOnPerson: true } });
        await w.check();
        at(60 * MIN);
        await w.check();
        expect(ports.endCall).not.toHaveBeenCalled();
    });

    it('the setting: tool_call_timeout_minutes, 15 by default, 0 = off', () => {
        const def = SETTINGS.find((s) => s.key === 'tool_call_timeout_minutes');
        expect(def?.default).toBe('15');
        expect(def?.scope).toBe('host');
        expect(toolTimeoutMsFrom({})).toBe(15 * MIN);
        expect(toolTimeoutMsFrom({ tool_call_timeout_minutes: '0' })).toBe(0);
        expect(toolTimeoutMsFrom({ tool_call_timeout_minutes: '30' })).toBe(30 * MIN);
        expect(toolTimeoutMsFrom({ tool_call_timeout_minutes: 'nonsense' })).toBe(15 * MIN);
    });
});

describe('a silent turn with no call: is the provider there? (Tynn #855)', () => {
    it('after the notice, dead or unresponsive ends the turn as stalled', async () => {
        for (const verdict of ['dead', 'unresponsive'] as const) {
            const { w, ports, at } = watchdog({ verdict });
            await w.check();
            at(20 * MIN);
            await w.check();
            expect(ports.flag).toHaveBeenCalledTimes(1);
            expect(ports.checkAlive).toHaveBeenCalledWith('a');
            expect(ports.stall).toHaveBeenCalledWith('a', 20 * MIN, verdict);
        }
    });

    it('alive or unknown leaves the turn alone, and is asked again next time', async () => {
        for (const verdict of ['alive', 'unknown'] as const) {
            const { w, ports, at } = watchdog({ verdict });
            await w.check();
            at(20 * MIN);
            await w.check();
            at(21 * MIN);
            await w.check();
            expect(ports.stall).not.toHaveBeenCalled();
            expect(ports.checkAlive).toHaveBeenCalledTimes(2);
        }
    });

    it('not before the notice, and not while a call runs (its timeout is the call\'s rule)', async () => {
        const { w, ports, at } = watchdog({ state: { call }, toolTimeoutMs: 0, verdict: 'dead' });
        await w.check();
        at(19 * MIN);
        await w.check();
        at(25 * MIN);
        await w.check();
        expect(ports.checkAlive).not.toHaveBeenCalled();
        expect(ports.stall).not.toHaveBeenCalled();
    });
});

describe('the words (Tynn #855)', () => {
    const live = (over: Partial<LiveSession>): LiveSession => ({
        running: true, turnState: 'working', startedAt: 0, mcpServers: [], pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null, ...over,
    } as LiveSession);

    it('the running call: label, command, age', () => {
        expect(runningCallWords(call, 21 * MIN)).toBe('Bash · az login --use-device-code · 21 min');
        expect(runningCallWords({ ...call, command: null }, 30_000)).toBe('Bash · under a minute');
        expect(runningCallWords({ ...call, command: 'a\nb' }, 2 * MIN)).toBe('Bash · a · 2 min');
    });

    it('stalled: the pill, the Dashboard and the chat never say Working', () => {
        const stalled = { reason: 'unresponsive' as const, silentMs: 34 * MIN, at: 0 };
        expect(stalledWords(stalled)).toBe('Stalled · no events for 34 min');
        const session = live({ turnState: 'idle', inTurn: false, stalled });
        expect(statePill(session, () => 0, { turns: 14 }).word).toBe('Stalled · no events for 34 min');
        const row = agentRowFor(agentRecord({ id: mintAgentId(), workspaceId: 'w', provider: 'claude', name: 'prism-engine' }), session, () => 0);
        expect(row.state).toBe('stalled');
        expect(statusOf(row)).toMatchObject({ word: 'Stalled', detail: 'no events for 34 min', tone: 'bad' });
    });
});

describe('the Deck item for a stalled turn (Tynn #855)', () => {
    it('offers Stop and Restart (and Dismiss), names the agent, and resolves to its action', () => {
        const book = new StalledTurnBook();
        const id = mintAgentId();
        book.record({ agentId: id, agentName: 'prism-engine', workspaceId: 'w', reason: 'dead', silentMs: 21 * MIN, at: 5 });
        const [item] = book.items();
        expect(item!.id).toBe(`${STALLED_DECK_PREFIX}${id}`);
        expect(item!.title).toContain('prism-engine');
        expect(item!.title).toMatch(/stalled/i);
        expect(item!.answer).toMatchObject({ kind: 'inline', options: [{ id: 'stop' }, { id: 'restart' }, { id: 'dismiss' }] });
        expect(resolveDeckAnswer(item!, 'restart')).toEqual({ kind: 'stalled-turn', agentId: id, action: 'restart' });
        expect(resolveDeckAnswer(item!, 'stop')).toEqual({ kind: 'stalled-turn', agentId: id, action: 'stop' });
        expect(book.clear(id)).toBe(true);
        expect(book.items()).toEqual([]);
    });
});

describe('Stop this call on the single protocol, never a new IPC (Tynn #855)', () => {
    it('stopToolCall is a remote method: a write, scoped to its agent', () => {
        expect(REMOTE_METHODS).toContain('stopToolCall');
        expect(capabilityOf('stopToolCall')).toBe('write');
        expect(AGENT_SCOPED_METHODS).toContain('stopToolCall');
    });
});
