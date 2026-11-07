import { afterAll, expect, it } from 'vitest';

/**
 * A WORKER STALLED WHILE THE GUARD WAITS. What happened on omarchy-test on 2026-11-03: six workers, each in the guard's 25 ms wait, past the hook's 10 s, and the run exited 1 with 0 tests
 * failed ("Hook timed out in 10000ms"). vitest fails a hook that has run past its time however it ended, so a stall alone is enough, with no mocked timer anywhere. The proof is the file
 * itself: this holds its worker's thread for 10.5 s from inside that wait, off the CPU. It also prints the guard's TEST_CLOCK_STALL line in every run, the positive control for that gauge.
 */
const HOLD_MS = 10_500;
const hold = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOLD_MS); };

it('a test with nothing to do', () => { expect(HOLD_MS).toBeGreaterThan(10_000); });

// This hook runs just before the guard's (hooks run last-registered first). The hold starts a few ms from now, inside the guard's 25 ms.
afterAll(() => { setTimeout(hold, 5); });
