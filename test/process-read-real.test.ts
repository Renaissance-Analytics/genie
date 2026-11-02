import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemProcessTree } from '../src/core/process-tree.js';
import { listProcessesAsync } from '../src/main/process-list.js';

/**
 * THE ASYNCHRONOUS READINGS, AGAINST THE REAL MACHINE (genie#1201). READ-ONLY: nothing is killed. On Windows this is the
 * PowerShell `Get-CimInstance Win32_Process` reading run with execFile instead of execFileSync — the one a quit or an
 * install now takes without holding main — so it runs on the Windows test VM too. Proves each reading still finds
 * this very process (the positive control every absence claim rides on) and leaves its own scanner out.
 */
describe('real readings, taken asynchronously', () => {
    it('the process tree reads the machine, and this process is in it', async () => {
        const rows = await systemProcessTree.read!();
        expect(rows).not.toBeNull();
        expect(rows!.some((r) => r.pid === process.pid && r.started > 0 && r.name.length > 0)).toBe(true);
        // The scanner it spawned (powershell / ps) is not reported as one of this process's children.
        expect(rows!.some((r) => r.ppid === process.pid && /^(powershell(\.exe)?|ps)$/i.test(r.name))).toBe(false);
    }, 60_000);

    it('the upgrade’s listing by path finds this process’s own executable', async () => {
        const rows = await listProcessesAsync();
        expect(rows.some((r) => r.pid === process.pid && r.executable.toLowerCase() === process.execPath.toLowerCase())).toBe(true);
    }, 60_000);

    /*
     * COUNTED IN LOOP TURNS, OVER A KNOWN SLOW READING — NOT WALL TIME (the #1416 way). This used a 5 ms setInterval and
     * asked that it fire during the reading. In the full suite on the omarchy VM (2026-11-02) a 35 ms reading saw it fire
     * 0 times: on a loaded machine the time goes to the spawn and the scheduler, and a reading can even finish within one
     * poll, so neither a timer nor a bare turn count could prove anything about a fast `ps`.
     *
     * So the reading is made SLOW on purpose — on Linux and macOS a `ps` that waits 300 ms and then runs the real one,
     * first on PATH; Windows' PowerShell reading takes hundreds of milliseconds by itself — and the loop's turns are counted
     * with a chain of setImmediate (one per check phase). An async reading leaves the loop turning all that time: at least
     * one turn, whatever the load. A synchronous one (execFileSync) blocks it all: zero. The CONTROL runs the same gauge
     * over an execFileSync of the same length and must read ZERO — the break-probe, in the test itself, every run.
     */
    const loopTurnsDuring = async (work: () => Promise<unknown>): Promise<number> => {
        let turns = 0;
        let counting = true;
        const tick = (): void => { if (!counting) return; turns += 1; setImmediate(tick); };
        setImmediate(tick);
        await work();
        counting = false;
        return turns;
    };

    /** On POSIX, a `ps` first on PATH that waits SLOW_MS, then runs the real one: the reading is slow, and still real. */
    const SLOW_MS = 300;
    const withSlowPs = async <T>(fn: () => Promise<T>): Promise<T> => {
        if (process.platform === 'win32') return fn();
        const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();
        const dir = mkdtempSync(join(tmpdir(), 'slow-ps-'));
        writeFileSync(join(dir, 'ps'), `#!/bin/sh\nsleep ${SLOW_MS / 1000}\nexec "${realPs}" "$@"\n`, { mode: 0o755 });
        const before = process.env.PATH;
        process.env.PATH = `${dir}${delimiter}${before ?? ''}`;
        try { return await fn(); } finally { process.env.PATH = before; rmSync(dir, { recursive: true, force: true }); }
    };

    it('while a reading runs, the event loop keeps turning (it is not execFileSync)', async () => {
        const turns = await withSlowPs(() => loopTurnsDuring(() => systemProcessTree.read!()));
        expect(turns).toBeGreaterThan(0);
    }, 60_000);

    it('CONTROL: the same gauge over an execFileSync of the same length reads ZERO turns (the gauge can go red)', async () => {
        const turns = await loopTurnsDuring(async () => { execFileSync(process.execPath, ['-e', `setTimeout(() => {}, ${SLOW_MS})`]); });
        expect(turns).toBe(0);
    }, 60_000);
});
