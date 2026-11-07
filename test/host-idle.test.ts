import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST_IDLE_MS, hostIdleMs, hostIdleStep, type HostHolds } from '../src/core/host-idle.js';

/**
 * THE HOST'S IDLE EXIT (the host split, P1b). Plan §4: "a host the person left running keeps running", and it keeps their
 * flows. The clock is for a host nobody owns: a window crashed and never relaunched, and nothing it could still do.
 * An armed flow or a scheduled task is something it can still do, with nothing running at this moment.
 */

const IDLE = 600_000;
const nothing: HostHolds = { agents: 0, windows: 0, ptys: 0, armedFlows: 0, scheduledTasks: 0 };

describe('hostIdleStep', () => {
    it('nothing held, before the limit: stays, and the clock is not moved', () => {
        expect(hostIdleStep(nothing, 1_000, 1_000 + IDLE - 1, IDLE)).toEqual({ lastBusy: 1_000, exit: false });
    });

    it('nothing held, at the limit: exits. The clock still ends a host nobody owns', () => {
        expect(hostIdleStep(nothing, 1_000, 1_000 + IDLE, IDLE)).toEqual({ lastBusy: 1_000, exit: true });
    });

    it.each<[keyof HostHolds]>([['agents'], ['windows'], ['ptys'], ['armedFlows'], ['scheduledTasks']])('%s alone holds the host and resets the clock, long past the limit', (kind) => {
        const now = 1_000 + 10 * IDLE;
        expect(hostIdleStep({ ...nothing, [kind]: 1 }, 1_000, now, IDLE)).toEqual({ lastBusy: now, exit: false });
    });

    it('disarmed again: the limit is counted from then, not from the last time anything ran', () => {
        const armedUntil = 1_000 + 10 * IDLE;
        const held = hostIdleStep({ ...nothing, armedFlows: 1 }, 1_000, armedUntil, IDLE);
        expect(hostIdleStep(nothing, held.lastBusy, armedUntil + IDLE - 1, IDLE).exit).toBe(false);
        expect(hostIdleStep(nothing, held.lastBusy, armedUntil + IDLE, IDLE).exit).toBe(true);
    });
});

/**
 * GENIE_HOST_IDLE_MS (P10.1c). A host in genie-cloud's container has no window to come back and nobody to start it again:
 * `0` there means it never idle-exits. Unset is today's ten minutes; any positive value is the wait, as today.
 */
describe('GENIE_HOST_IDLE_MS', () => {
    it('0: never — no wait at all, not "exit at once"', () => {
        expect(hostIdleMs('0')).toBeNull();
    });

    it('unset: ten minutes, as today (CONTROL)', () => {
        expect(DEFAULT_HOST_IDLE_MS).toBe(600_000);
        expect(hostIdleMs(undefined)).toBe(600_000);
    });

    it('a positive value: that many ms, as today (CONTROL)', () => {
        expect(hostIdleMs('5000')).toBe(5_000);
        expect(hostIdleStep(nothing, 1_000, 6_000, hostIdleMs('5000')!).exit).toBe(true);
    });
});
