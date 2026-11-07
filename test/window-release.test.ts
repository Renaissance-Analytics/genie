import { describe, expect, it } from 'vitest';
import { socketsOwnedBy } from '../src/core/netstat.js';
import { windowReleased } from '../src/main/window-release.js';

/*
 * WHEN AN ENDED WINDOW HAS LET GO (Tynn #400). The hang watchdog starts a new window only after the old one's process
 * is gone AND no socket is still owned by it. Windows shows a killed process's sockets for a moment after the process
 * table drops it (CI, measure job 128497635554: pid 6952 "no such process" at 19:01:43.465, its 9357 and 9356 still
 * LISTENING). Bounded: at the bound it answers false, and the caller reopens anyway.
 */
const NETSTAT = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:9357         0.0.0.0:0              LISTENING       6952',
    '  TCP    127.0.0.1:9357         127.0.0.1:56912        ESTABLISHED     6952',
    '  TCP    127.0.0.1:56904        127.0.0.1:9356         TIME_WAIT       0',
    '  TCP    127.0.0.1:9356         0.0.0.0:0              LISTENING       1476',
    '  TCP    127.0.0.1:69520        127.0.0.1:9000         ESTABLISHED     69520',
].join('\r\n');

describe('socketsOwnedBy: the TCP sockets netstat lists for one pid', () => {
    it('counts the rows whose PID column is that pid, and nothing that only contains its digits', () => {
        expect(socketsOwnedBy(NETSTAT, 6952)).toBe(2);
        expect(socketsOwnedBy(NETSTAT, 1476)).toBe(1);
        expect(socketsOwnedBy(NETSTAT, 695)).toBe(0);
    });
    it('a TIME_WAIT row belongs to nobody (pid 0)', () => {
        expect(socketsOwnedBy(NETSTAT, 0)).toBe(0);
    });
});

describe('windowReleased: the process gone, then its sockets', () => {
    function clock() {
        let t = 0;
        return { now: () => t, sleep: async (ms: number) => { t += ms; } };
    }

    it('waits through "process gone, sockets still listed" until both are gone', async () => {
        const c = clock();
        const answers = { alive: [true, false, false, false], sockets: [2, 2, 0] };
        const seen: string[] = [];
        const ok = await windowReleased(6952, {
            ...c,
            alive: () => { const a = answers.alive.shift() ?? false; seen.push(`alive ${a}`); return a; },
            sockets: async () => { const s = answers.sockets.shift() ?? 0; seen.push(`sockets ${s}`); return s; },
        });
        expect(ok).toBe(true);
        expect(seen).toEqual(['alive true', 'alive false', 'sockets 2', 'alive false', 'sockets 2', 'alive false', 'sockets 0']);
    });

    it('at the bound it answers false, having waited no longer', async () => {
        const c = clock();
        const ok = await windowReleased(6952, { ...c, alive: () => false, sockets: async () => 1, boundMs: 10_000 });
        expect(ok).toBe(false);
        expect(c.now()).toBeGreaterThanOrEqual(10_000);
        expect(c.now()).toBeLessThan(10_500);
    });

    it('CONTROL: a window already gone with nothing held is released at once', async () => {
        const c = clock();
        expect(await windowReleased(6952, { ...c, alive: () => false, sockets: async () => 0 })).toBe(true);
        expect(c.now()).toBe(0);
    });
});
