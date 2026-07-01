import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    attachTerminalSocket,
    mobileTermFanout,
    setTerminalRepaintHandler,
    COALESCE_CAP,
    REPAINT_COOLDOWN_MS,
    _resetBridgeForTest,
} from '../terminal-bridge';

/**
 * A dropped frame deletes bytes from the middle of a full-screen TUI's redraw
 * stream, so the client's screen scrambles and can't self-heal. When a drop
 * reaches a client the bridge must ask the pty to REPAINT (server SIGWINCH
 * nudge) so a clean frame resyncs it — debounced so a drop storm can't flood the
 * link with redraws.
 */

/** A minimal OPEN ws with a spyable send and a drained outgoing buffer. */
function fakeWs() {
    return { readyState: 1, bufferedAmount: 0, send: vi.fn() } as never;
}

describe('repaint on drop', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        _resetBridgeForTest();
    });
    afterEach(() => {
        _resetBridgeForTest();
        vi.useRealTimers();
    });

    it('asks the pty to repaint when a dropped frame reaches a client', () => {
        const repaint = vi.fn();
        setTerminalRepaintHandler(repaint);
        const ws = fakeWs() as unknown as { send: ReturnType<typeof vi.fn> };
        attachTerminalSocket('t1', ws as never);

        // Overflow the coalesce cap so the buffer evicts + latches `dropped`.
        mobileTermFanout('t1', 'x'.repeat(COALESCE_CAP + 100));
        // The batch timer fires → drain (dropped) → requestRepaint.
        vi.advanceTimersByTime(25);

        expect(repaint).toHaveBeenCalledTimes(1);
        expect(repaint).toHaveBeenCalledWith('t1');
        // The client also got a 'dropped' marker on the wire.
        const types = ws.send.mock.calls.map((c) => JSON.parse(c[0] as string).type);
        expect(types).toContain('dropped');
    });

    it('does NOT repaint when the output fits (no drop)', () => {
        const repaint = vi.fn();
        setTerminalRepaintHandler(repaint);
        attachTerminalSocket('t2', fakeWs());
        mobileTermFanout('t2', 'hello world');
        vi.advanceTimersByTime(25);
        expect(repaint).not.toHaveBeenCalled();
    });

    it('debounces repaints within the cooldown, then allows another', () => {
        const repaint = vi.fn();
        setTerminalRepaintHandler(repaint);
        attachTerminalSocket('t3', fakeWs());

        mobileTermFanout('t3', 'x'.repeat(COALESCE_CAP + 100));
        vi.advanceTimersByTime(25);
        // A second drop still inside the cooldown → no second repaint.
        mobileTermFanout('t3', 'y'.repeat(COALESCE_CAP + 100));
        vi.advanceTimersByTime(25);
        expect(repaint).toHaveBeenCalledTimes(1);

        // Once the cooldown elapses, a fresh drop repaints again.
        vi.advanceTimersByTime(REPAINT_COOLDOWN_MS);
        mobileTermFanout('t3', 'z'.repeat(COALESCE_CAP + 100));
        vi.advanceTimersByTime(25);
        expect(repaint).toHaveBeenCalledTimes(2);
    });
});
