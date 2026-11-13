/**
 * A WINDOW WHOSE LINK TO A HOST DROPPED DIALS AGAIN (beta.61 blocker, step five; Azure pair gp-11110200, checks 6 and 7).
 * The remote host is genie-host's now: when the Drone's genie-host restarts, every link drops, and a Pilot's window that
 * never dialled by itself stayed disconnected, with no badge and not driving. `dropped()` dials the same host again after
 * `delay(attempt)`, and again after each failed dial, until one connects or `stop()`. A dial that connects ends the run;
 * the next drop starts a new one. One run at a time.
 */
export function redialer(input: { dial: () => Promise<boolean>; schedule: (ms: number, fn: () => void) => () => void; delay: (attempt: number) => number }): { dropped(): void; stop(): void } {
    let running = false, stopped = false, attempt = 0;
    let cancel: () => void = () => {};
    const next = (): void => {
        if (stopped) return;
        cancel = input.schedule(input.delay(attempt), () => {
            if (stopped) return;
            void input.dial().then((ok) => ok, () => false).then((ok) => {
                if (stopped) return;
                if (ok) { running = false; attempt = 0; return; }
                attempt += 1;
                next();
            });
        });
    };
    return {
        dropped: () => { if (running || stopped) return; running = true; attempt = 0; next(); },
        stop: () => { stopped = true; running = false; cancel(); },
    };
}
