import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentPulse, ACTIVE_WINDOW_MS, BUCKET_COUNT, COALESCE_MS } from '../agent-pulse';

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
