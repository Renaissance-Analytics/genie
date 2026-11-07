import { describe, expect, it } from 'vitest';
import { activityTotal, activityWords, onTheClock, trayOnlyStep, trayProbeEnabled, TRAY_ONLY_GRACE_MS, type HostActivity } from '../src/core/tray-only.js';

/**
 * TRAY-ONLY GENIE (P1b; the owner, 2026-11-02: "as long as any genie services are running, that tray should be there so
 * users can shut them down or restart if needed"). "Just close the UI" closes the windows and the window process stays as
 * the tray while genie-host runs anything: agents, terminals, kept processes (sites among them), services. Once NOTHING is
 * left and no window is open, it waits a grace period — an agent restarting, a process in its restart backoff, must not end
 * Genie between two lives — and then shuts everything down and exits.
 */

const none: HostActivity = { agents: 0, terminals: 0, processes: 0, services: 0, armedFlows: 0, scheduledTasks: 0, browser: 0 };

describe('the host’s activity, in words and in total', () => {
    it('counts every kind, and words only the kinds that run', () => {
        expect(activityTotal({ ...none, agents: 3, terminals: 2, processes: 1, services: 1 })).toBe(7);
        expect(activityWords({ ...none, agents: 3, terminals: 2, processes: 1, services: 1 })).toBe('3 agents, 2 terminals, 1 process, 1 service');
        expect(activityWords({ ...none, agents: 1 })).toBe('1 agent');
        expect(activityWords(none)).toBe('');
    });
});

describe('what waits on the host\u2019s clock', () => {
    it('words and totals an armed flow and a scheduled task with the rest', () => {
        expect(activityTotal({ ...none, armedFlows: 2, scheduledTasks: 1 })).toBe(3);
        expect(activityWords({ ...none, agents: 1, armedFlows: 2, scheduledTasks: 1 })).toBe('1 agent, 2 armed flows, 1 scheduled task');
    });

    it('onTheClock counts armed flows, and scheduled tasks still wanted; a paused task or a plain kept process is not on the clock', () => {
        const flows = [{ armed: true }, { armed: false }, { armed: true }];
        const kept = [{ wanted: true, schedule: { cron: '0 3 * * *' } }, { wanted: false, schedule: { cron: '0 4 * * *' } }, { wanted: true }];
        expect(onTheClock(flows, kept)).toEqual({ armedFlows: 2, scheduledTasks: 1 });
    });
});

describe('trayOnlyStep', () => {
    it.each<[string, Partial<HostActivity>]>([['an armed flow', { armedFlows: 1 }], ['a scheduled task', { scheduledTasks: 1 }]])('tray-only with %s and nothing running: stays, or it would never fire', (_name, waiting) => {
        expect(trayOnlyStep({ uiOpen: false, activity: { ...none, ...waiting } }, 0, 10 * TRAY_ONLY_GRACE_MS)).toEqual({ quietSince: null, exit: false });
    });

    it('a window open: stay, and the quiet clock is not running', () => {
        expect(trayOnlyStep({ uiOpen: true, activity: none }, 0, 10 * TRAY_ONLY_GRACE_MS)).toEqual({ quietSince: null, exit: false });
    });

    it('tray-only with anything running: stay, the clock reset', () => {
        expect(trayOnlyStep({ uiOpen: false, activity: { ...none, services: 1 } }, 0, 10 * TRAY_ONLY_GRACE_MS)).toEqual({ quietSince: null, exit: false });
    });

    it('tray-only and nothing left: the clock starts; before the grace it stays, at the grace it exits', () => {
        const start = trayOnlyStep({ uiOpen: false, activity: none }, null, 1_000);
        expect(start).toEqual({ quietSince: 1_000, exit: false });
        expect(trayOnlyStep({ uiOpen: false, activity: none }, 1_000, 1_000 + TRAY_ONLY_GRACE_MS - 1)).toEqual({ quietSince: 1_000, exit: false });
        expect(trayOnlyStep({ uiOpen: false, activity: none }, 1_000, 1_000 + TRAY_ONLY_GRACE_MS)).toEqual({ quietSince: 1_000, exit: true });
    });

    it('something starts again inside the grace (an agent restarting): the clock resets, nothing ends', () => {
        expect(trayOnlyStep({ uiOpen: false, activity: { ...none, agents: 1 } }, 1_000, 1_000 + TRAY_ONLY_GRACE_MS - 1)).toEqual({ quietSince: null, exit: false });
    });

    it('the grace is a minute', () => {
        expect(TRAY_ONLY_GRACE_MS).toBe(60_000);
    });
});

/**
 * THE TRAY PROBE IS FOR THE VM PROOF ONLY. main.ts can expose a read-only view of the tray (and its items' own clicks) on the
 * main process's globalThis, for scripts/quit-keeps-host-cdp.mjs over the inspector — but only when the launch says so
 * with GENIE_TRAY_PROBE=1. Without it (every real launch) the hook does not exist.
 */
describe('trayProbeEnabled', () => {
    it('only GENIE_TRAY_PROBE=1 turns it on; absent, empty, other values and GENIE_E2E do not', () => {
        expect(trayProbeEnabled({})).toBe(false);
        expect(trayProbeEnabled({ GENIE_TRAY_PROBE: '' })).toBe(false);
        expect(trayProbeEnabled({ GENIE_TRAY_PROBE: 'true' })).toBe(false);
        expect(trayProbeEnabled({ GENIE_E2E: '1' })).toBe(false);
        expect(trayProbeEnabled({ GENIE_TRAY_PROBE: '1' })).toBe(true);
    });
});
