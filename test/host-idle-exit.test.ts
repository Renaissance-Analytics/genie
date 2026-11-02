import { describe, expect, it } from 'vitest';
import { hostIdle } from '../src/core/host-idle.js';

/**
 * THE HOST'S IDLE EXIT GIVES WAY TO THE PERSON (the host split, P1b; plan §6: "a host the person left running keeps
 * running"). A host nobody uses still ends itself after the idle time, as in phase 1 — a window that crashed must not
 * leave one behind for ever. But a host the person left running with "Just close the UI" is never ended by the clock:
 * not with agents running, and not with nothing running either (its sites, flows and schedules are what it was left for).
 */

const IDLE = 600_000;
const quiet = { sessions: 0, windows: 0, livePtys: 0, leftRunning: false };

describe('hostIdle', () => {
    it('anything running or any window connected → busy', () => {
        expect(hostIdle({ ...quiet, sessions: 1 }, 0, IDLE * 2, IDLE)).toBe('busy');
        expect(hostIdle({ ...quiet, windows: 1 }, 0, IDLE * 2, IDLE)).toBe('busy');
        expect(hostIdle({ ...quiet, livePtys: 3 }, 0, IDLE * 2, IDLE)).toBe('busy');
    });

    it('a host nobody left running: waits out the idle time, then exits (the phase-1 rule, kept)', () => {
        expect(hostIdle(quiet, 0, IDLE - 1, IDLE)).toBe('wait');
        expect(hostIdle(quiet, 0, IDLE, IDLE)).toBe('exit');
    });

    it('a host the person LEFT RUNNING never exits on the clock, however long it is idle', () => {
        expect(hostIdle({ ...quiet, leftRunning: true }, 0, IDLE, IDLE)).toBe('wait');
        expect(hostIdle({ ...quiet, leftRunning: true }, 0, IDLE * 1000, IDLE)).toBe('wait');
    });
});
