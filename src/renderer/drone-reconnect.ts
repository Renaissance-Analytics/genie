import { reconnectDelay } from '../core/mobile.js';

/**
 * A DRONE THAT WENT AWAY IS DIALLED AGAIN BY ITSELF (Tynn #651; the owner, 2026-11-12: "updating drone machines need to
 * reconnect after they upgrade"). A Tynn workstation's window said the drop with Retry and stayed there: a drone that
 * upgraded, quit or restarted needed a click on every Pilot. The window keeps the connection's intent instead.
 *
 * - `dropped()`: the link was up and went away. The hold is `restarting` ("aion is restarting, reconnecting…"); the drone
 *   is dialled with backoff (`reconnectDelay`: 0.5 s doubling to 15 s), and a dial that connects lifts the hold. Gone past
 *   `giveUpAfterMs` (~5 min), the hold lifts with no connection: the window shows that last dial's failure, with Retry.
 * - `skewed()`: the drone answered on a Genie older than this Pilot needs. The hold is `skew` (the update sentence), and
 *   the drone is dialled again until it answers on a new enough build: updating it restarts it, and nothing tells this
 *   window when that is done. Never given up on while the window is open, and backed off (`skewDelay`: 20 s, 40 s, 80 s…
 *   capped at 5 min) because each dial asks Tynn for a way in: every 20 s, a window left open was ~4,300 Tynn calls a day.
 * - `retryNow()`: the person pressed Retry. One dial now, the backoff started over; its outcome decides as above.
 *
 * `dial` says how a dial went: `connected`, `skew` (an older drone), or `failed`. One run at a time; `stop()` ends it.
 */
export type DroneHold = 'restarting' | 'skew' | null;
export type DialOutcome = 'connected' | 'skew' | 'failed';

export interface DroneReconnect {
    dropped(): void;
    skewed(): void;
    retryNow(): void;
    /** The person disconnected: the run ends and the hold lifts; a later drop starts a new one. */
    cancel(): void;
    stop(): void;
}

export const DRONE_GIVE_UP_MS = 5 * 60_000;
export const DRONE_SKEW_FIRST_MS = 20_000;
export const DRONE_SKEW_MAX_MS = 5 * 60_000;

/** How long before older-drone dial `attempt` (0-based): 20 s doubling, capped at 5 min. */
export function skewDelay(attempt: number): number {
    return Math.min(DRONE_SKEW_MAX_MS, DRONE_SKEW_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
}

export function droneReconnect(input: {
    dial: () => Promise<DialOutcome>;
    schedule: (ms: number, fn: () => void) => () => void;
    now: () => number;
    onHold: (hold: DroneHold) => void;
    onGiveUp?: () => void;
    delay?: (attempt: number) => number;
    giveUpAfterMs?: number;
    skewDelay?: (attempt: number) => number;
}): DroneReconnect {
    const delay = input.delay ?? reconnectDelay;
    const giveUpAfter = input.giveUpAfterMs ?? DRONE_GIVE_UP_MS;
    const skewWait = input.skewDelay ?? skewDelay;
    let hold: DroneHold = null;
    let attempt = 0;
    let skewAttempt = 0;
    let since = 0;
    // Each run has its own number: a dial that settles after a stop, a Retry or a new run decides nothing.
    let run = 0;
    let cancel: () => void = () => {};
    let stopped = false;

    const setHold = (next: DroneHold): void => { hold = next; input.onHold(next); };
    const end = (): void => { run += 1; cancel(); cancel = () => {}; };

    const settle = (mine: number, outcome: DialOutcome): void => {
        if (stopped || mine !== run) return;
        if (outcome === 'connected') { end(); setHold(null); return; }
        if (outcome === 'skew') {
            if (hold !== 'skew') { setHold('skew'); skewAttempt = 0; } else skewAttempt += 1;
            later(mine, skewWait(skewAttempt));
            return;
        }
        if (hold === 'restarting') {
            if (input.now() - since >= giveUpAfter) { end(); setHold(null); input.onGiveUp?.(); return; }
            attempt += 1;
            later(mine, delay(attempt));
            return;
        }
        // Still too old, or not answering mid-update: dialled again, the update sentence kept.
        if (hold === 'skew') { skewAttempt += 1; later(mine, skewWait(skewAttempt)); return; }
        // A Retry that failed: said with Retry, as before.
        end();
    };
    const dialNow = (mine: number): void => {
        void input.dial().then((o) => o, () => 'failed' as const).then((o) => settle(mine, o));
    };
    const later = (mine: number, ms: number): void => {
        cancel = input.schedule(ms, () => { if (!stopped && mine === run) dialNow(mine); });
    };

    return {
        dropped: () => {
            if (stopped || hold !== null) return;
            end();
            attempt = 0;
            since = input.now();
            setHold('restarting');
            later(run, delay(attempt));
        },
        skewed: () => {
            if (stopped || hold === 'skew') return;
            end();
            setHold('skew');
            skewAttempt = 0;
            later(run, skewWait(skewAttempt));
        },
        retryNow: () => {
            if (stopped) return;
            end();
            if (hold !== null) setHold(null);
            dialNow(run);
        },
        cancel: () => { end(); if (hold !== null) setHold(null); },
        stop: () => { stopped = true; end(); },
    };
}
