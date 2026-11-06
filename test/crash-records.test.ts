import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { release } from 'node:os';
import { CRASH_KEEP, CRASH_MAX_BYTES, crashCause, type CrashHeader, type CrashRecord } from '../src/core/crash-record.js';
import { crashHeader, latestCrashRecord, readLifecycleTail, writeCrashRecord } from '../src/main/crash-records.js';

/**
 * THE CRASH RECORDS (Tynn story #386): `<genieRoot()>/runtime/crash/<ISO time>.json`, one per hang, lost window or exit
 * path. Bounded: the newest 20 are kept, and each file is under 256 KB whatever it was handed. Written synchronously and
 * never throwing: the paths that write them are the ones where the process is about to end.
 */

let dir: string | null = null;
afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
});
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), 'crash-records-')));

const HEADER: CrashHeader = { schema: 1, version: '2.0.0-beta.60', build: '2.0.0-beta.60+abc123def456', os: 'linux', osRelease: '6.1.0', arch: 'x64', uptimeS: 42 };
const hang = (at: number, lifecycle: string[] = []): CrashRecord => ({
    ...HEADER,
    kind: 'hang',
    at: new Date(at).toISOString(),
    windowPid: 4242,
    lastBeatAt: new Date(at - 30_000).toISOString(),
    lifecycle,
    stalls: [],
    memory: [],
    agents: [],
});

describe('crash records on disk', () => {
    it('one file per record, named by its time (no colon: a Windows file name cannot hold one), read back whole', () => {
        const crash = join(fresh(), 'runtime', 'crash');
        const at = Date.UTC(2026, 10, 6, 10, 0, 0, 0);
        const file = writeCrashRecord(crash, hang(at));
        expect(file).not.toBeNull();
        expect(readdirSync(crash)).toEqual(['2026-11-06T10-00-00.000Z.json']);
        expect(JSON.parse(readFileSync(file!, 'utf8'))).toMatchObject({ kind: 'hang', windowPid: 4242 });
        // Two records in the same millisecond keep both.
        writeCrashRecord(crash, hang(at));
        expect(readdirSync(crash)).toHaveLength(2);
        expect(latestCrashRecord(crash)).toMatchObject({ kind: 'hang' });
    });

    it('THE CAP: the newest 20 are kept, the oldest removed', () => {
        const crash = fresh();
        const base = Date.UTC(2026, 10, 6, 10, 0, 0, 0);
        for (let i = 0; i < 25; i++) writeCrashRecord(crash, hang(base + i * 1000));
        const names = readdirSync(crash).sort();
        expect(CRASH_KEEP).toBe(20);
        expect(names).toHaveLength(20);
        expect(names[0]).toBe(`${new Date(base + 5 * 1000).toISOString().replace(/:/g, '-')}.json`);
        expect(names[19]).toBe(`${new Date(base + 24 * 1000).toISOString().replace(/:/g, '-')}.json`);
        // A file that is not a record is not counted, and not removed.
        writeFileSync(join(crash, 'README.txt'), 'kept');
        writeCrashRecord(crash, hang(base + 99_000));
        expect(readdirSync(crash)).toContain('README.txt');
        expect(readdirSync(crash).filter((n) => n.endsWith('.json'))).toHaveLength(20);
    });

    it('THE 256 KB BOUND: a record handed megabytes of lines is written under it, keeping the NEWEST lines', () => {
        const crash = fresh();
        const lines = Array.from({ length: 5000 }, (_, i) => `2026-11-06T10:00:00.000Z line ${i} ${'x'.repeat(400)}`);
        const file = writeCrashRecord(crash, hang(Date.UTC(2026, 10, 6, 10, 0, 0, 0), lines));
        expect(CRASH_MAX_BYTES).toBe(256 * 1024);
        expect(statSync(file!).size).toBeLessThan(CRASH_MAX_BYTES);
        const back = JSON.parse(readFileSync(file!, 'utf8')) as { lifecycle: string[] };
        expect(back.lifecycle.length).toBeGreaterThan(0);
        expect(back.lifecycle.length).toBeLessThanOrEqual(200);
        expect(back.lifecycle[back.lifecycle.length - 1]).toContain('line 4999 ');
        // One enormous line is cut, not the whole record lost.
        const huge = writeCrashRecord(crash, hang(Date.UTC(2026, 10, 6, 11, 0, 0, 0), ['y'.repeat(2 * 1024 * 1024)]));
        expect(statSync(huge!).size).toBeLessThan(CRASH_MAX_BYTES);
    });

    it('never throws: a crash folder that cannot be made answers null', () => {
        const root = fresh();
        const blocker = join(root, 'not-a-dir');
        writeFileSync(blocker, 'a file where the folder would be');
        expect(() => writeCrashRecord(join(blocker, 'crash'), hang(Date.now()))).not.toThrow();
        expect(writeCrashRecord(join(blocker, 'crash'), hang(Date.now()))).toBeNull();
    });
});

describe('the common header', () => {
    it('this process: the version and build it is given, the OS, its release, the arch, its uptime in seconds, schema 1', () => {
        const h = crashHeader('2.0.0-beta.60', '2.0.0-beta.60+abc');
        expect(h).toEqual({ schema: 1, version: '2.0.0-beta.60', build: '2.0.0-beta.60+abc', os: process.platform, osRelease: release(), arch: process.arch, uptimeS: expect.any(Number) });
        expect(Number.isInteger(h.uptimeS)).toBe(true);
        expect(h.uptimeS).toBeGreaterThanOrEqual(0);
    });

    it('a record written to disk keeps its header, cut to fit or not', () => {
        const crash = fresh();
        const file = writeCrashRecord(crash, hang(Date.UTC(2026, 10, 6, 12, 0, 0, 0), Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(2000)}`)));
        expect(JSON.parse(readFileSync(file!, 'utf8'))).toMatchObject(HEADER);
    });
});

describe('the last 200 lifecycle lines', () => {
    it('the newest 200 of lifecycle.log, reaching into lifecycle.log.1 when the live file has fewer', () => {
        const runtime = fresh();
        writeFileSync(join(runtime, 'lifecycle.log.1'), Array.from({ length: 150 }, (_, i) => `old ${i}`).join('\n') + '\n');
        writeFileSync(join(runtime, 'lifecycle.log'), Array.from({ length: 120 }, (_, i) => `new ${i}`).join('\n') + '\n');
        const tail = readLifecycleTail(runtime);
        expect(tail).toHaveLength(200);
        expect(tail[0]).toBe('old 70');
        expect(tail[199]).toBe('new 119');
        // No log at all: nothing, not a throw.
        expect(readLifecycleTail(join(runtime, 'missing'))).toEqual([]);
    });
});

describe('the cause the safe-mode banner shows, from the record', () => {
    it('a hang, an exit with its code, and anything else', () => {
        expect(crashCause(hang(Date.now()))).toBe('it stopped responding');
        expect(crashCause({ ...HEADER, kind: 'exit', at: '2026-11-06T10:00:00.000Z', pid: 1, reason: 'exit', code: 3, rssMb: 100, agents: [] })).toBe('it exited with code 3');
        expect(crashCause({ ...HEADER, kind: 'lost', at: '2026-11-06T10:00:00.000Z', windowPid: 1, lastBeatAt: null, lastRssMb: null, lifecycle: [], memory: [] })).toBe('it ended without a trace');
        expect(crashCause(null)).toBe('it ended without a trace');
    });
});
