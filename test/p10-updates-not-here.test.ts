import { describe, expect, it } from 'vitest';
import { NO_UPDATES_HERE } from '../src/core/host-runtime.js';
import { UpdatesService, type HelperLaunch, type UpdaterEvent } from '../src/main/updates-host.js';

/**
 * THE UPDATER ON A HOST WITH NO ELECTRON (P10.1d). genie-cloud's container is updated by its deployment, and its genie-host
 * runs on plain Node: there is no Genie executable to start in `--updater` mode, and no window to start again. Check,
 * download and install answer "Updates aren't available on this host", the schedule checks nothing, and no helper is
 * ever launched — nor a window relaunched.
 */

const tick = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 1)); };

function service(unavailable?: string) {
    const started: HelperLaunch[] = [];
    const relaunched: HelperLaunch[] = [];
    const scheduled: number[] = [];
    let svc: UpdatesService | null = null;
    const helperSend = (event: UpdaterEvent): void => {
        if (event.kind !== 'request') return;
        queueMicrotask(() => { svc!.helperCall('reply', [event.id, true, event.op === 'check' ? { version: '2.0.1' } : null], 'helper'); });
    };
    svc = new UpdatesService({
        host: { installDir: '/opt/genie', ownPid: 100, processes: () => [], kill: () => true, caseInsensitive: false, clock: () => 5, channel: 'stable' },
        startHelper: (launch) => { started.push(launch); queueMicrotask(() => { svc!.helperLinked('helper', 900, helperSend); }); },
        defaultLaunch: { file: '/opt/genie/genie', args: ['--updater'] },
        windowConnected: () => true,
        exit: () => {},
        helperPatienceMs: 50,
        handOverFailed: (_why, launch) => { relaunched.push(launch); },
        ...(unavailable ? { unavailable } : {}),
    });
    const schedule = (fn: () => void, ms: number) => { scheduled.push(ms); setTimeout(fn, 0); return () => {}; };
    return { svc, started, relaunched, scheduled, schedule };
}

describe('updates on a host with no Electron', () => {
    it.each(['check', 'download', 'install'])('%s answers that updates are not available here, and launches no helper', async (method) => {
        const r = service(NO_UPDATES_HERE);
        await expect(r.svc.call(method, method === 'install' ? [4242] : [], { window: true })).rejects.toThrow(NO_UPDATES_HERE);
        await tick();
        expect(r.started).toEqual([]);
        expect(r.relaunched).toEqual([]);
    });

    it('the schedule checks nothing: no clock, no helper', async () => {
        const r = service(NO_UPDATES_HERE);
        r.svc.startAutoCheck(r.schedule, { initialMs: 1, intervalMs: 1 });
        await tick();
        expect(r.scheduled).toEqual([]);
        expect(r.started).toEqual([]);
    });

    it('CONTROL: an Electron host launches the helper for a check, as today', async () => {
        const r = service();
        await r.svc.call('check', [], { window: true });
        await tick();
        expect(r.started).toEqual([{ file: '/opt/genie/genie', args: ['--updater'] }]);
    });

    it('CONTROL: an Electron host\'s schedule checks, through the helper', async () => {
        const r = service();
        r.svc.startAutoCheck(r.schedule, { initialMs: 1, intervalMs: 1 });
        await tick();
        expect(r.scheduled.length).toBeGreaterThan(0);
        expect(r.started).toHaveLength(1);
    });
});
