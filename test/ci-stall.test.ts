import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, imported for its functions
import { findStalls, parseSamples, stallsBetween } from '../scripts/ci/stall.mjs';

/*
 * A ROW THAT FAILED WHILE THE MACHINE STALLED IS INFRA (Tynn #660). The 62c gates on Azure D8ads_v5 failed Windows rows
 * (safe-mode, packaged-launcher, artboard) during stalls that were the machine's: the disk queue at 6-9 with the CPU
 * idle for ~24 s. scripts/ci/machine-sampler.ps1 and .sh write one MACHINE line every ~2 s for the whole run;
 * scripts/ci/stall.mjs reads them and says whether the machine stalled between a row's start and end. Its rules:
 *   disk   Windows: disk queue >= 4 with the CPU under 30 %, held for 10 s or more (the machine waiting, not working)
 *   io     Linux: PSI io "full" avg10 >= 30 % (every runnable task waiting on the disk), held for 10 s or more
 *   steal  Linux: the hypervisor took >= 25 % of the CPU time, held for 10 s or more
 *   pause  either: the sampler itself was not run for 5 s past its interval (the whole VM paused)
 */

const T0 = Date.UTC(2026, 10, 12, 17, 0, 0);
const win = (t: number, q: number, cpu: number, gap = 2000) => `MACHINE ${t} gap=${gap} disk_q=${q} cpu=${cpu} disk_ms=40`;
const lin = (t: number, f: Partial<Record<'io_full' | 'steal' | 'cpu', number>>, gap = 2000) =>
    `MACHINE ${t} gap=${gap} cpu=${f.cpu ?? 20} steal=${f.steal ?? 0} io_some=1 io_full=${f.io_full ?? 0} mem_full=0 load=1.2`;
/** n samples 2 s apart from `from`, each made by `line`. */
const run = (from: number, n: number, line: (t: number) => string) => Array.from({ length: n }, (_, i) => line(from + i * 2000));

describe('stall.mjs: reading the samples', () => {
    it('reads a Windows line and a Linux line, field by field', () => {
        const [w, l] = parseSamples([win(T0, 7, 4), lin(T0 + 2000, { io_full: 41, steal: 3 })].join('\n'));
        expect(w).toMatchObject({ t: T0, gap: 2000, f: { disk_q: 7, cpu: 4, disk_ms: 40 } });
        expect(l).toMatchObject({ t: T0 + 2000, f: { io_full: 41, steal: 3, load: 1.2 } });
    });
    it('skips what is not a sample, and a line the sampler wrote when its counters failed keeps its time and gap', () => {
        const s = parseSamples(['garbage', '', `MACHINE ${T0} gap=2100 error=counters`, '\r'].join('\r\n'));
        expect(s).toHaveLength(1);
        expect(s[0]).toMatchObject({ t: T0, gap: 2100 });
    });
});

describe('stall.mjs: what is a stall', () => {
    it('THE 62c STALL: disk queue 6-9 with the CPU idle for ~24 s is a disk stall, and says its numbers', () => {
        const samples = parseSamples([...run(T0, 12, (t) => win(t, 6 + ((t / 2000) % 4), 5))].join('\n'));
        const stalls = findStalls(samples);
        expect(stalls).toHaveLength(1);
        expect(stalls[0]).toMatchObject({ kind: 'disk', from: T0, to: T0 + 22000 });
        expect(stalls[0].seconds).toBe(24);
        expect(stalls[0].detail).toMatch(/queue 6-9/);
        expect(stalls[0].detail).toMatch(/CPU 5-5 %/);
    });
    it('CONTROL: the same queue with the CPU busy is the machine working, not stalled', () => {
        expect(findStalls(parseSamples(run(T0, 12, (t) => win(t, 8, 85)).join('\n')))).toEqual([]);
    });
    it('a blip under 10 s is not a stall (4 samples, 8 s)', () => {
        const lines = [...run(T0, 4, (t) => win(t, 9, 2)), ...run(T0 + 8000, 6, (t) => win(t, 0, 2))];
        expect(findStalls(parseSamples(lines.join('\n')))).toEqual([]);
    });
    it('a quiet queue between two halves breaks the run: two 6 s halves are not one 12 s stall', () => {
        const lines = [...run(T0, 3, (t) => win(t, 9, 2)), win(T0 + 6000, 0, 2), ...run(T0 + 8000, 3, (t) => win(t, 9, 2))];
        expect(findStalls(parseSamples(lines.join('\n')))).toEqual([]);
    });
    it('the sampler not run for 14 s when it asked for 2 is a pause of the whole machine', () => {
        const lines = [win(T0, 0, 3), win(T0 + 2000, 0, 3), win(T0 + 16000, 0, 3, 14000), win(T0 + 18000, 0, 3)];
        const stalls = findStalls(parseSamples(lines.join('\n')));
        expect(stalls).toHaveLength(1);
        expect(stalls[0]).toMatchObject({ kind: 'pause', from: T0 + 2000, to: T0 + 16000, seconds: 14 });
    });
    it('CONTROL: a gap of 6 s (under interval + 5 s) is not a pause', () => {
        expect(findStalls(parseSamples([win(T0, 0, 3), win(T0 + 6000, 0, 3, 6000)].join('\n')))).toEqual([]);
    });
    it('Linux: io full >= 30 % held for 10 s is an io stall; steal >= 25 % held for 10 s is a steal stall', () => {
        const io = findStalls(parseSamples(run(T0, 6, (t) => lin(t, { io_full: 45 })).join('\n')));
        expect(io.map((s: { kind: string }) => s.kind)).toEqual(['io']);
        const steal = findStalls(parseSamples(run(T0, 6, (t) => lin(t, { steal: 40 })).join('\n')));
        expect(steal.map((s: { kind: string }) => s.kind)).toEqual(['steal']);
    });
    it('CONTROL: Linux io some is the machine working; io full under 30 % is not a stall', () => {
        expect(findStalls(parseSamples(run(T0, 10, (t) => lin(t, { io_full: 12, cpu: 90 })).join('\n')))).toEqual([]);
    });
});

describe('stall.mjs: was it during THIS row', () => {
    const samples = parseSamples([...run(T0, 30, (t) => win(t, 0, 20)), ...run(T0 + 60000, 12, (t) => win(t, 8, 3)), ...run(T0 + 84000, 30, (t) => win(t, 0, 20))].join('\n'));
    it('a stall inside the row is the row\'s', () => {
        const r = stallsBetween(samples, T0 + 50000, T0 + 100000);
        expect(r.stalls.map((s: { kind: string }) => s.kind)).toEqual(['disk']);
        expect(r.samples).toBeGreaterThan(20);
    });
    it('a stall that only overlaps the row\'s start or end is the row\'s too', () => {
        expect(stallsBetween(samples, T0 + 70000, T0 + 120000).stalls).toHaveLength(1);
        expect(stallsBetween(samples, T0 + 10000, T0 + 62000).stalls).toHaveLength(1);
    });
    it('CONTROL: a stall that ended before the row began, or began after it ended, is not', () => {
        expect(stallsBetween(samples, T0 + 90000, T0 + 140000).stalls).toEqual([]);
        expect(stallsBetween(samples, T0, T0 + 50000).stalls).toEqual([]);
    });
    it('a row with no sample in it says so: it reads 0 samples, never "no stall"', () => {
        expect(stallsBetween(samples, T0 + 500000, T0 + 600000)).toEqual({ samples: 0, stalls: [] });
    });
});

describe('stall.mjs as the row loops call it: node scripts/ci/stall.mjs <samples> <from-ms> <to-ms>', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-stall-'));
    const file = join(dir, 'machine-samples.log');
    writeFileSync(file, [...run(T0, 30, (t) => win(t, 0, 20)), ...run(T0 + 60000, 12, (t) => win(t, 8, 3))].join('\n') + '\n');
    const cli = (...a: string[]) => spawnSync(process.execPath, [join(__dirname, '..', 'scripts', 'ci', 'stall.mjs'), ...a], { encoding: 'utf8' });

    it('exit 0 and one STALL line per stall when the machine stalled in the window', () => {
        const r = cli(file, String(T0 + 50000), String(T0 + 90000));
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/^STALL disk 24 s from 2026-11-12T17:01:00\.000Z: queue 8-8, CPU 3-3 %/m);
    });
    it('exit 1 and NO STALL with the count of samples it read, when it did not (the count is the gauge)', () => {
        const r = cli(file, String(T0), String(T0 + 40000));
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/^NO STALL in 21 samples/m);
    });
    it('exit 3 and NO SAMPLES when the window has none (the sampler was not running)', () => {
        const r = cli(file, String(T0 + 500000), String(T0 + 600000));
        expect(r.status).toBe(3);
        expect(r.stdout).toMatch(/^NO SAMPLES between /m);
    });
    it('exit 3 for a samples file that is not there', () => {
        expect(cli(join(dir, 'none.log'), '1', '2').status).toBe(3);
    });
    it('exit 64 when it is called wrong', () => {
        expect(cli(file).status).toBe(64);
    });
});
