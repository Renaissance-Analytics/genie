import { describe, expect, it } from 'vitest';
import { AUTO_CHECK, UpdateHost, type UpdaterPort } from '../src/main/updater.js';

/**
 * GENIE CHECKS FOR UPDATES BY ITSELF. v1 checked at boot and opened the sheet; Genie 2.0.0-beta.5
 * never checked unless a script or a remote call asked, so an installed Genie 2 would never learn
 * that the next build existed (genie2#91, the owner: "will the new version pick up on an update
 * automatically? don't make me do this twice"). The host arms ONE check shortly after boot and
 * re-arms on a long interval; nothing downloads by itself (unchanged). Counted with a fake
 * scheduler the test fires by hand: the number of timers armed and the number of checks made are
 * what is asserted, never "a check happened".
 */
interface Timer { fn: () => void; ms: number; cancelled: boolean }

function scheduler() {
    const timers: Timer[] = [];
    const schedule = (fn: () => void, ms: number) => {
        const t: Timer = { fn, ms, cancelled: false };
        timers.push(t);
        return () => { t.cancelled = true; };
    };
    const pending = () => timers.filter((t) => !t.cancelled && !(t as Timer & { fired?: boolean }).fired);
    const fire = async (t: Timer) => { (t as Timer & { fired?: boolean }).fired = true; t.fn(); await new Promise((r) => setTimeout(r, 0)); };
    return { timers, schedule, pending, fire };
}

function fakePort() {
    const fake = { checks: 0, answer: { version: '2.0.0-beta.7' } as { version: string } | null, port: null as unknown as UpdaterPort };
    fake.port = {
        configure: () => {},
        check: async () => { fake.checks += 1; return fake.answer; },
        download: async () => {},
        quitAndInstall: () => {},
    };
    return fake;
}

function host(fake: ReturnType<typeof fakePort>) {
    return new UpdateHost({ port: fake.port, installDir: 'C:\\Users\\u\\AppData\\Local\\Programs\\Genie', ownPid: 1, processes: () => [], kill: () => true });
}

describe('UpdateHost.startAutoCheck', () => {
    it('arms exactly ONE check after boot, at the boot delay — and nothing has been checked yet', () => {
        const fake = fakePort();
        const s = scheduler();
        host(fake).startAutoCheck(s.schedule);
        expect(s.pending().map((t) => t.ms)).toEqual([AUTO_CHECK.initialMs]);
        expect(fake.checks).toBe(0);
    });

    it('the boot timer checks the feed, the state becomes available, and ONE interval timer is re-armed', async () => {
        const fake = fakePort();
        const s = scheduler();
        const h = host(fake);
        h.startAutoCheck(s.schedule);
        await s.fire(s.pending()[0]!);
        expect(fake.checks).toBe(1);
        expect(h.state().phase).toBe('available');
        expect(h.state().version).toBe('2.0.0-beta.7');
        expect(s.pending().map((t) => t.ms)).toEqual([AUTO_CHECK.intervalMs]);
    });

    it('the interval timer checks again; a feed with nothing is "none"; still one timer pending', async () => {
        const fake = fakePort();
        const s = scheduler();
        const h = host(fake);
        h.startAutoCheck(s.schedule);
        await s.fire(s.pending()[0]!);
        fake.answer = null;
        await s.fire(s.pending()[0]!);
        expect(fake.checks).toBe(2);
        expect(h.state().phase).toBe('none');
        expect(s.pending()).toHaveLength(1);
    });

    it('CONTROL: nothing downloads by itself — after the automatic check the state stays available', async () => {
        const fake = fakePort();
        const s = scheduler();
        const h = host(fake);
        h.startAutoCheck(s.schedule);
        await s.fire(s.pending()[0]!);
        await new Promise((r) => setTimeout(r, 20));
        expect(h.state().phase).toBe('available');
    });

    it('stop cancels the pending timer, and a timer that fires after stop checks nothing', async () => {
        const fake = fakePort();
        const s = scheduler();
        const stop = host(fake).startAutoCheck(s.schedule);
        const t = s.pending()[0]!;
        stop();
        expect(s.pending()).toHaveLength(0);
        await s.fire(t);
        expect(fake.checks).toBe(0);
    });

    it('the boot delay is seconds, the interval hours — a check soon after launch, then rarely', () => {
        expect(AUTO_CHECK.initialMs).toBeGreaterThanOrEqual(5_000);
        expect(AUTO_CHECK.initialMs).toBeLessThanOrEqual(30_000);
        expect(AUTO_CHECK.intervalMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
        expect(AUTO_CHECK.intervalMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });
});
