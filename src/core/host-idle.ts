/**
 * THE HOST'S IDLE EXIT (the host split, P1b; plan §4: "a host the person left running keeps running", with its flows).
 *
 * The clock is for a host nobody owns: a window crashed and was never relaunched, and there is nothing it could still do.
 * Anything it holds resets the clock, and that includes what waits on its clock (an armed flow, a scheduled task), which
 * has nothing running between firings and would otherwise never fire.
 */

export interface HostHolds {
    /** Agent sessions running. */
    readonly agents: number;
    /** Windows (and the tray's process) connected. */
    readonly windows: number;
    /** Live spawn-host children's ptys. */
    readonly ptys: number;
    readonly armedFlows: number;
    readonly scheduledTasks: number;
}

/** Ten minutes: how long a host that holds nothing, with no window, waits before it exits (GENIE_HOST_IDLE_MS unset). */
export const DEFAULT_HOST_IDLE_MS = 10 * 60_000;

/** `GENIE_HOST_IDLE_MS` as the host reads it: the wait in ms, or `null` for `0` — never idle-exit (P10.1c: genie-cloud's host). */
export function hostIdleMs(raw: string | undefined): number | null {
    const ms = Number(raw ?? DEFAULT_HOST_IDLE_MS);
    return ms === 0 ? null : ms;
}

export function hostIdleStep(holds: HostHolds, lastBusy: number, now: number, idleMs: number): { readonly lastBusy: number; readonly exit: boolean } {
    if (holds.agents + holds.windows + holds.ptys + holds.armedFlows + holds.scheduledTasks > 0) return { lastBusy: now, exit: false };
    return { lastBusy, exit: now - lastBusy >= idleMs };
}
