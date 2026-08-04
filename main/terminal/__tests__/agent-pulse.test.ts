import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    AgentPulse,
    ACTIVE_WINDOW_MS,
    AGENT_WORK_WINDOW_MS,
    BUCKET_COUNT,
    COALESCE_MS,
} from '../agent-pulse';

/**
 * AgentPulse tracker — the per-workspace terminal-activity model behind the
 * real-time rail glow + 1-minute sparkline. Pure (injected clock + emitter), so
 * bucketing, the active window, coalescing, and the idle transition are all
 * deterministically testable with fake timers.
 */
describe('AgentPulse', () => {
    let clock = 0;
    const now = () => clock;
    let ap: AgentPulse;
    let events: { workspaceId: string; active: boolean; bytes: number }[];

    beforeEach(() => {
        vi.useFakeTimers();
        clock = 1_000_000;
        ap = new AgentPulse(now);
        events = [];
        ap.setEmitter((e) => events.push(e));
    });
    afterEach(() => {
        ap._reset();
        vi.useRealTimers();
    });

    it('emits active:true immediately on the first bytes', () => {
        ap.note('ws1', 100);
        expect(events).toEqual([{ workspaceId: 'ws1', active: true, bytes: 100 }]);
        expect(ap.isActive('ws1')).toBe(true);
    });

    it('goes idle (active:false) after the active window with no more bytes', () => {
        ap.note('ws1', 50);
        events.length = 0;
        clock += ACTIVE_WINDOW_MS + 10;
        vi.advanceTimersByTime(ACTIVE_WINDOW_MS + 10);
        expect(events.some((e) => !e.active)).toBe(true);
        expect(ap.isActive('ws1')).toBe(false);
    });

    it('stays active while bytes keep arriving within the window', () => {
        ap.note('ws1', 10);
        for (let i = 0; i < 5; i++) {
            clock += ACTIVE_WINDOW_MS - 100;
            vi.advanceTimersByTime(ACTIVE_WINDOW_MS - 100);
            ap.note('ws1', 10);
        }
        expect(ap.isActive('ws1')).toBe(true);
        expect(events.some((e) => !e.active)).toBe(false);
    });

    it('bins bytes into the current second; snapshot has 60 buckets', () => {
        ap.note('ws1', 100);
        ap.note('ws1', 50);
        const snap = ap.snapshot();
        expect(snap.ws1).toHaveLength(BUCKET_COUNT);
        expect(snap.ws1[BUCKET_COUNT - 1]).toBe(150);
    });

    it('places older bytes into earlier buckets', () => {
        ap.note('ws1', 10);
        clock += 3000; // 3 seconds later
        ap.note('ws1', 20);
        const snap = ap.snapshot();
        expect(snap.ws1[BUCKET_COUNT - 1]).toBe(20); // current second
        expect(snap.ws1[BUCKET_COUNT - 1 - 3]).toBe(10); // 3s ago
    });

    it('coalesces sustained output — one immediate emit, then a trailing flush', () => {
        ap.note('ws1', 10); // active:true, immediate
        const afterFirst = events.length;
        ap.note('ws1', 10); // within COALESCE_MS → no immediate emit
        ap.note('ws1', 10);
        expect(events.length).toBe(afterFirst); // coalesced

        clock += COALESCE_MS + 10;
        vi.advanceTimersByTime(COALESCE_MS + 10);
        // The trailing flush pushed the accumulated bytes (20) exactly once.
        const trailing = events.slice(afterFirst);
        expect(trailing).toHaveLength(1);
        expect(trailing[0].bytes).toBe(20);
    });

    it('prunes buckets older than the 60s window', () => {
        ap.note('ws1', 5);
        clock += 70_000; // well past the window
        ap.note('ws1', 7);
        const sum = ap.snapshot().ws1.reduce((a, b) => a + b, 0);
        expect(sum).toBe(7); // the old 5 aged out
    });

    it('tracks workspaces independently', () => {
        ap.note('ws1', 10);
        ap.note('ws2', 20);
        expect(ap.isActive('ws1')).toBe(true);
        expect(ap.isActive('ws2')).toBe(true);
        const snap = ap.snapshot();
        expect(snap.ws1[BUCKET_COUNT - 1]).toBe(10);
        expect(snap.ws2[BUCKET_COUNT - 1]).toBe(20);
    });

    it('ignores empty workspace id / non-positive bytes', () => {
        ap.note('', 100);
        ap.note('ws1', 0);
        ap.note('ws1', -5);
        expect(events).toHaveLength(0);
        expect(ap.snapshot()).toEqual({});
    });
});

/**
 * Mid-turn agents glow INDEPENDENT of byte output. A working agent that is quiet
 * (waiting on a tool/API call) must keep its workspace lit — the byte-only window
 * darkened it after 1.5s, so the user couldn't see agents were running and an
 * upgrade killed them silently. "Working" spans a turn: it starts on agent output
 * and ends on imDone / exit (or a generous backstop for an agent that never signals).
 */
describe('AgentPulse — mid-turn agents glow independent of byte output', () => {
    let clock = 0;
    const now = () => clock;
    let ap: AgentPulse;
    let events: { workspaceId: string; active: boolean; bytes: number }[];

    beforeEach(() => {
        vi.useFakeTimers();
        clock = 1_000_000;
        ap = new AgentPulse(now);
        events = [];
        ap.setEmitter((e) => events.push(e));
    });
    afterEach(() => {
        ap._reset();
        vi.useRealTimers();
    });

    it('lights the workspace the moment an agent starts working — no bytes needed', () => {
        ap.noteAgentWorking('ws1', 't1');
        expect(ap.isActive('ws1')).toBe(true);
        expect(events).toEqual([{ workspaceId: 'ws1', active: true, bytes: 0 }]);
    });

    it('STAYS lit through a long byte-silence while the agent is mid-turn (the bug)', () => {
        ap.note('ws1', 50); // a little output…
        ap.noteAgentWorking('ws1', 't1'); // …then the agent goes quiet mid-turn
        events.length = 0;
        clock += ACTIVE_WINDOW_MS * 20; // far past the byte window — a tool-call wait
        vi.advanceTimersByTime(ACTIVE_WINDOW_MS * 20);
        expect(ap.isActive('ws1')).toBe(true);
        expect(events.some((e) => !e.active)).toBe(false); // never went dark
    });

    it('darkens only when the agent ends its turn (imDone) and no bytes flow', () => {
        ap.noteAgentWorking('ws1', 't1');
        events.length = 0;
        ap.noteAgentIdle('ws1', 't1');
        expect(ap.isActive('ws1')).toBe(false);
        expect(events).toEqual([{ workspaceId: 'ws1', active: false, bytes: 0 }]);
    });

    it('a byte-idle timeout does NOT darken a workspace whose agent still works', () => {
        ap.note('ws1', 10);
        ap.noteAgentWorking('ws1', 't1');
        events.length = 0;
        clock += ACTIVE_WINDOW_MS + 50;
        vi.advanceTimersByTime(ACTIVE_WINDOW_MS + 50); // byte idle timer fires
        expect(ap.isActive('ws1')).toBe(true);
        expect(events.some((e) => !e.active)).toBe(false);
    });

    it('backstops an agent that never signals: decays after AGENT_WORK_WINDOW_MS', () => {
        ap.noteAgentWorking('ws1', 't1');
        events.length = 0;
        clock += AGENT_WORK_WINDOW_MS + 1000;
        vi.advanceTimersByTime(AGENT_WORK_WINDOW_MS + 1000);
        expect(ap.isActive('ws1')).toBe(false);
        expect(events.some((e) => !e.active)).toBe(true);
    });

    it('stays lit until the LAST agent in the workspace ends its turn', () => {
        ap.noteAgentWorking('ws1', 't1');
        ap.noteAgentWorking('ws1', 't2');
        events.length = 0;
        ap.noteAgentIdle('ws1', 't1'); // one done, one still working
        expect(ap.isActive('ws1')).toBe(true);
        expect(events.some((e) => !e.active)).toBe(false);
        ap.noteAgentIdle('ws1', 't2'); // last one done
        expect(ap.isActive('ws1')).toBe(false);
        expect(events.some((e) => !e.active)).toBe(true);
    });

    it('re-arms the backstop on continued output so a long active turn never decays early', () => {
        ap.noteAgentWorking('ws1', 't1');
        // Keep working with output just under the backstop repeatedly.
        for (let i = 0; i < 4; i++) {
            clock += AGENT_WORK_WINDOW_MS - 1000;
            vi.advanceTimersByTime(AGENT_WORK_WINDOW_MS - 1000);
            ap.noteAgentWorking('ws1', 't1'); // fresh output re-arms
        }
        expect(ap.isActive('ws1')).toBe(true);
        expect(events.some((e) => !e.active)).toBe(false);
    });
});
