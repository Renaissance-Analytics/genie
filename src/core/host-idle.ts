/**
 * GENIE-HOST'S IDLE EXIT (the host split; P1b gives it way to the person, plan §6). A host with nothing running and no
 * window for `idleMs` ends itself — a window that crashed must not leave one behind for ever. A host the person LEFT
 * RUNNING ("Just close the UI") is never ended by the clock: its sites, flows and schedules are what it was left for.
 *
 * `busy` = something runs or a window is connected (the caller restarts the clock); `wait` = idle, but not ending;
 * `exit` = idle long enough, and nobody left it running.
 */
export interface HostLoad {
    readonly sessions: number;
    readonly windows: number;
    readonly livePtys: number;
    readonly leftRunning: boolean;
}

export function hostIdle(load: HostLoad, lastBusy: number, now: number, idleMs: number): 'busy' | 'wait' | 'exit' {
    if (load.sessions > 0 || load.windows > 0 || load.livePtys > 0) return 'busy';
    if (load.leftRunning) return 'wait';
    return now - lastBusy >= idleMs ? 'exit' : 'wait';
}
