import { describe, expect, it, vi } from 'vitest';
import type { CrashHeader, CrashRecord } from '../src/core/crash-record.js';
import { HangWatchdog } from '../src/main/hang-watchdog.js';

/**
 * A HUNG WINDOW IS REOPENED (#1623 review; Tynn story #386). genie-host ends a window that stopped beating; the tray lives
 * in that window's process, so ending it alone would leave the person with Genie silently gone. So genie-host STARTS A
 * NEW WINDOW after the old one is ended — the installed Genie, from the window's published launch spec — and tells it
 * what happened. A loop is capped: a 4th hang within 10 minutes is recorded and NOT reopened.
 */

const MB = 1024 * 1024;
const HEADER: CrashHeader = { schema: 1, version: '2.0.0-beta.60', build: '2.0.0-beta.60+abc', os: 'linux', osRelease: '6.1.0', arch: 'x64', uptimeS: 42 };

function rig(options: { released?: (pid: number) => Promise<boolean> } = {}) {
    let t = 1_700_000_000_000;
    let tick: (() => void) | null = null;
    const records: CrashRecord[] = [];
    const killed: number[] = [];
    const order: string[] = [];
    const relaunched: number[] = [];
    const hangs: Array<{ at: number; hangs: number; relaunched: boolean }> = [];
    const dog = new HangWatchdog({
        now: () => t,
        every: (fn) => { tick = fn; return () => { tick = null; }; },
        write: (record) => { records.push(record); },
        kill: (pid) => { killed.push(pid); order.push(`kill ${pid}`); return Promise.resolve(true); },
        alive: () => false,
        hostRss: () => 300 * MB,
        agents: () => [],
        lifecycle: () => [],
        log: () => {},
        header: () => HEADER,
        relaunch: () => { relaunched.push(t); order.push('relaunch'); },
        onHang: (hang) => { hangs.push(hang); },
        ...(options.released ? { released: options.released } : {}),
    });
    dog.start();
    const second = (n = 1) => { for (let i = 0; i < n; i++) { t += 1000; tick?.(); } };
    /** One window that beats once and then freezes: 30 s later it is a hang. */
    const freeze = (conn: string, pid: number) => { dog.beat(conn, { pid, rss: 512 * MB }); second(30); };
    return { dog, records, killed, order, relaunched, hangs, second, freeze, now: () => t };
}

describe('after a hang, genie-host reopens the window', () => {
    it('hang → the window is ended → THEN a new window is started (once)', async () => {
        const r = rig();
        r.freeze('conn-1', 4242);
        expect(r.killed).toEqual([4242]);
        await vi.waitFor(() => expect(r.relaunched).toHaveLength(1));
        // The new window is started only after the frozen one was ended: the single-instance lock is free by then.
        expect(r.order).toEqual(['kill 4242', 'relaunch']);
        expect(r.records).toHaveLength(1);
        expect(r.records[0]).toMatchObject({ kind: 'hang', relaunched: true, hangsRecent: 1 });
        expect(r.hangs).toEqual([{ at: r.now(), hangs: 1, relaunched: true }]);
        r.second(60);
        await Promise.resolve();
        expect(r.relaunched).toHaveLength(1);
    });

    it('THE CAP: the 4th hang within 10 minutes is recorded and NOT reopened', async () => {
        const r = rig();
        for (let i = 1; i <= 3; i++) { r.freeze(`conn-${i}`, 1000 + i); r.second(60); }
        await vi.waitFor(() => expect(r.relaunched).toHaveLength(3));
        r.freeze('conn-4', 1004);
        await Promise.resolve();
        await Promise.resolve();
        expect(r.killed).toEqual([1001, 1002, 1003, 1004]);
        expect(r.relaunched).toHaveLength(3);
        expect(r.records.map((x) => (x.kind === 'hang' ? [x.relaunched, x.hangsRecent] : x.kind))).toEqual([[true, 1], [true, 2], [true, 3], [false, 4]]);
        expect(r.hangs.at(-1)).toMatchObject({ hangs: 4, relaunched: false });
    });

    /*
     * THE NEW WINDOW WAITS FOR THE OLD ONE TO LET GO (Tynn #400). On Windows a killed process leaves the process table
     * before its sockets close: CI (measure job 128497635554) read the ended window's pid gone at 19:01:43.465 while its
     * ports were still listening, and the window the host had started at 19:01:42.921 found its port taken and came up
     * without it. So the new window starts only once the old one's process AND the sockets it held are gone, bounded so
     * a person is never left with Genie gone.
     */
    it('the new window starts only once the ended one has let go of its process and sockets', async () => {
        let letGo: (v: boolean) => void = () => {};
        const asked: number[] = [];
        const r = rig({ released: (pid) => { asked.push(pid); return new Promise<boolean>((done) => { letGo = done; }); } });
        r.freeze('conn-1', 4242);
        await vi.waitFor(() => expect(asked).toEqual([4242]));
        await Promise.resolve();
        await Promise.resolve();
        expect(r.relaunched).toHaveLength(0);
        letGo(true);
        await vi.waitFor(() => expect(r.relaunched).toHaveLength(1));
        expect(r.order).toEqual(['kill 4242', 'relaunch']);
    });

    it('CONTROL: a release that never comes (its bound passed) still reopens the window', async () => {
        const r = rig({ released: () => Promise.resolve(false) });
        r.freeze('conn-1', 4242);
        await vi.waitFor(() => expect(r.relaunched).toHaveLength(1));
    });

    it('CONTROL: hangs further apart than 10 minutes are each reopened', async () => {
        const r = rig();
        for (let i = 1; i <= 4; i++) { r.freeze(`conn-${i}`, 1000 + i); r.second(4 * 60); }
        await vi.waitFor(() => expect(r.relaunched).toHaveLength(4));
        expect(r.records.map((x) => (x.kind === 'hang' ? x.relaunched : x.kind))).toEqual([true, true, true, true]);
    });
});
