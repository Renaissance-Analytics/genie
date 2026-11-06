import { describe, expect, it, vi } from 'vitest';
import type { UpdateChannel } from '../src/core/update-channel.js';
import { UpdatesService, type UpdaterEvent } from '../src/main/updates-host.js';

/**
 * P5b, ruling 2: the host's schedule downloads exactly when the update CHANNEL's own `autoDownload` says so
 * (updaterConfigFor), window or no window. Every channel is manual today, so here `dev` is made automatic to drive the
 * other branch; `stable` stays manual as the control.
 */
vi.mock('../src/core/update-channel.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../src/core/update-channel.js')>();
    return { ...real, updaterConfigFor: (channel: UpdateChannel) => ({ ...real.updaterConfigFor(channel), autoDownload: channel === 'dev' }) };
});

const tick = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 1)); };

function service(channel: UpdateChannel, windowOpen: boolean) {
    const calls: string[] = [];
    let svc: UpdatesService | null = null;
    const helperSend = (event: UpdaterEvent): void => {
        if (event.kind !== 'request') return;
        calls.push(event.op);
        const value = event.op === 'check' ? { version: '2.0.1' } : null;
        queueMicrotask(() => { svc!.helperCall('reply', [event.id, true, value], 'helper'); });
    };
    svc = new UpdatesService({
        host: { installDir: '/opt/genie', ownPid: 100, processes: () => [], kill: () => true, caseInsensitive: false, clock: () => 5, channel },
        startHelper: () => { queueMicrotask(() => { svc!.helperLinked('helper', 900, helperSend); }); },
        defaultLaunch: { file: '/opt/genie/genie', args: ['--updater'] },
        windowConnected: () => windowOpen,
        exit: () => {},
        helperPatienceMs: 50,
    });
    return { svc, calls };
}

describe('the schedule downloads by the channel’s own setting, window or no window', () => {
    it.each([false, true])('an automatic channel, window open: %s — checked AND downloaded on the schedule', async (windowOpen) => {
        const { svc, calls } = service('dev', windowOpen);
        const fire: Array<() => void> = [];
        svc.startAutoCheck((fn) => { fire.push(fn); return () => {}; }, { initialMs: 1, intervalMs: 1 });
        fire[0]!();
        await tick();
        expect(calls).toEqual(['check', 'download']);
        expect(svc.dump()).toMatchObject({ phase: 'downloaded', version: '2.0.1' });
    });

    it.each([false, true])('CONTROL: a manual channel, window open: %s — only checked', async (windowOpen) => {
        const { svc, calls } = service('stable', windowOpen);
        const fire: Array<() => void> = [];
        svc.startAutoCheck((fn) => { fire.push(fn); return () => {}; }, { initialMs: 1, intervalMs: 1 });
        fire[0]!();
        await tick();
        expect(calls).toEqual(['check']);
        expect(svc.dump().phase).toBe('available');
    });
});
