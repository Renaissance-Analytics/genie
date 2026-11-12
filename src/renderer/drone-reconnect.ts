/**
 * STUB (Tynn #651, tests-first commit): the names the tests import, doing nothing, so every test fails on its assertion
 * rather than on a missing module. The implementation is the next commit.
 */
export type DroneHold = 'restarting' | 'skew' | null;
export type DialOutcome = 'connected' | 'skew' | 'failed';

export interface DroneReconnect {
    dropped(): void;
    skewed(): void;
    retryNow(): void;
    cancel(): void;
    stop(): void;
}

export function droneReconnect(_input: {
    dial: () => Promise<DialOutcome>;
    schedule: (ms: number, fn: () => void) => () => void;
    now: () => number;
    onHold: (hold: DroneHold) => void;
    onGiveUp?: () => void;
    delay?: (attempt: number) => number;
    giveUpAfterMs?: number;
    skewDelay?: (attempt: number) => number;
}): DroneReconnect {
    return { dropped: () => {}, skewed: () => {}, retryNow: () => {}, cancel: () => {}, stop: () => {} };
}
