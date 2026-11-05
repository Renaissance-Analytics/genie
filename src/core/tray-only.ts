/**
 * TRAY-ONLY GENIE (the host split, P1b; the owner, 2026-11-02: "Keep the tray up … as long as any genie services are
 * running, that tray should be there so users can shut them down or restart if needed").
 *
 * "Just close the UI" closes every window; the window process stays as the tray while genie-host runs anything — agents,
 * terminals, kept processes (sites and their front door among them), services. The tray says what, and offers Open Genie
 * (a new window, the same host), Restart and Shut down everything. Once NOTHING is left and no window is open, Genie waits
 * TRAY_ONLY_GRACE_MS — an agent restarting, or a kept process in its restart backoff, must not end Genie between two lives
 * — and then shuts everything down and exits. Not the host's 10-minute idle rule: a person who closed the UI is not using
 * Genie, and a tray that outlives everything it stood for is clutter.
 */

export interface HostActivity {
    /** Agent sessions running. */
    readonly agents: number;
    /** Terminals open. */
    readonly terminals: number;
    /** Kept processes running or restarting (sites, workers, the front door). */
    readonly processes: number;
    /** Service engines running (databases, Redis, mail…). */
    readonly services: number;
    /** Armed flows: nothing runs between firings, and with no host they would never fire. */
    readonly armedFlows: number;
    /** Scheduled tasks still wanted; the same. */
    readonly scheduledTasks: number;
}

/** What waits on the host's clock, from the host's own lists. A paused task and a plain kept process are not on it. */
export function onTheClock(
    flows: ReadonlyArray<{ readonly armed: boolean }>,
    kept: ReadonlyArray<{ readonly wanted: boolean; readonly schedule?: unknown }>,
): { readonly armedFlows: number; readonly scheduledTasks: number } {
    return { armedFlows: flows.filter((f) => f.armed).length, scheduledTasks: kept.filter((p) => p.wanted && p.schedule).length };
}

export const TRAY_ONLY_GRACE_MS = 60_000;

export function activityTotal(a: HostActivity): number {
    return a.agents + a.terminals + a.processes + a.services + a.armedFlows + a.scheduledTasks;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 agents, 2 terminals, 1 process, 1 service" — only the kinds that run; '' for none. */
export function activityWords(a: HostActivity): string {
    const parts: string[] = [];
    if (a.agents > 0) parts.push(count(a.agents, 'agent', 'agents'));
    if (a.terminals > 0) parts.push(count(a.terminals, 'terminal', 'terminals'));
    if (a.processes > 0) parts.push(count(a.processes, 'process', 'processes'));
    if (a.services > 0) parts.push(count(a.services, 'service', 'services'));
    if (a.armedFlows > 0) parts.push(count(a.armedFlows, 'armed flow', 'armed flows'));
    if (a.scheduledTasks > 0) parts.push(count(a.scheduledTasks, 'scheduled task', 'scheduled tasks'));
    return parts.join(', ');
}

/**
 * One look: whether the tray-only Genie stays or exits now, and since when it has been quiet (null = not quiet). A window
 * open, or anything running, resets the clock.
 */
export function trayOnlyStep(input: { readonly uiOpen: boolean; readonly activity: HostActivity }, quietSince: number | null, now: number, graceMs: number = TRAY_ONLY_GRACE_MS): { quietSince: number | null; exit: boolean } {
    if (input.uiOpen || activityTotal(input.activity) > 0) return { quietSince: null, exit: false };
    const since = quietSince ?? now;
    return { quietSince: since, exit: now - since >= graceMs };
}

/**
 * THE TRAY PROBE'S GATE. main.ts exposes a read-only view of the tray — and its menu items' own clicks — on the main
 * process's globalThis, ONLY for the VM proof (scripts/quit-keeps-host-cdp.mjs, which reaches it over the main process's
 * inspector: Electron's Tray can be neither asked what it shows nor clicked from outside). Only a launch with
 * GENIE_TRAY_PROBE=1 installs it; every real launch has none. Its own name, never GENIE_E2E: Genie 1's GENIE_E2E changed
 * what the product did, and a proof of a product that behaves differently proves nothing.
 */
export const TRAY_PROBE_ENV = 'GENIE_TRAY_PROBE';

export function trayProbeEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return env[TRAY_PROBE_ENV] === '1';
}
