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

export function hostIdleStep(holds: HostHolds, lastBusy: number, now: number, idleMs: number): { readonly lastBusy: number; readonly exit: boolean } {
    if (holds.agents + holds.windows + holds.ptys + holds.armedFlows + holds.scheduledTasks > 0) return { lastBusy: now, exit: false };
    return { lastBusy, exit: now - lastBusy >= idleMs };
}
