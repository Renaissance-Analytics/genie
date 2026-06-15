import { describe, expect, it } from 'vitest';
import {
    MAX_RESTART_ATTEMPTS,
    decideOnExit,
    restartDelay,
} from '../process-supervisor';

describe('restartDelay', () => {
    it('grows exponentially from the base', () => {
        expect(restartDelay(0)).toBe(1000);
        expect(restartDelay(1)).toBe(2000);
        expect(restartDelay(2)).toBe(4000);
        expect(restartDelay(3)).toBe(8000);
    });
    it('caps the delay', () => {
        expect(restartDelay(20)).toBe(30_000);
    });
});

describe('decideOnExit', () => {
    it('a deliberate stop is terminal and resets the attempt counter', () => {
        expect(
            decideOnExit({ userStopped: true, restartOnExit: true, exitCode: 0, attempt: 3 }),
        ).toEqual({ status: 'stopped', restartInMs: null, nextAttempt: 0 });
    });

    it('a clean exit with no restart-on-exit is "stopped"', () => {
        expect(
            decideOnExit({ userStopped: false, restartOnExit: false, exitCode: 0, attempt: 0 }),
        ).toEqual({ status: 'stopped', restartInMs: null, nextAttempt: 0 });
    });

    it('a non-zero exit with no restart-on-exit is "crashed"', () => {
        expect(
            decideOnExit({ userStopped: false, restartOnExit: false, exitCode: 1, attempt: 0 }),
        ).toEqual({ status: 'crashed', restartInMs: null, nextAttempt: 0 });
    });

    it('restart-on-exit schedules a backed-off relaunch and increments the attempt', () => {
        expect(
            decideOnExit({ userStopped: false, restartOnExit: true, exitCode: 1, attempt: 0 }),
        ).toEqual({ status: 'restarting', restartInMs: 1000, nextAttempt: 1 });
        expect(
            decideOnExit({ userStopped: false, restartOnExit: true, exitCode: 1, attempt: 2 }),
        ).toEqual({ status: 'restarting', restartInMs: 4000, nextAttempt: 3 });
    });

    it('gives up as "failed" once the attempt cap is reached', () => {
        expect(
            decideOnExit({
                userStopped: false,
                restartOnExit: true,
                exitCode: 1,
                attempt: MAX_RESTART_ATTEMPTS,
            }),
        ).toEqual({ status: 'failed', restartInMs: null, nextAttempt: MAX_RESTART_ATTEMPTS });
    });
});
