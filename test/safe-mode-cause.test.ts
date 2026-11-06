import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CrashHeader, CrashRecord } from '../src/core/crash-record.js';
import { previousRunCause, writeCrashRecord } from '../src/main/crash-records.js';
import { SafeMode } from '../src/main/safe-mode-host.js';

/**
 * THE BANNER'S CAUSE, FROM THE CRASH RECORDS (Tynn story #386, cut 3 into cut 2's safe mode). Safe mode said
 * "(unknown)" until the watchdog existed. Now the cause is read from the newest crash record of the run that did not
 * end cleanly — the records written since that run's host started (its `host.json` `startedAt`, still on disk when the
 * next host opens safe mode): a hang → "it stopped responding"; an exit with a code → "it exited with code N"; anything
 * else, or nothing → "it ended without a trace".
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), 'safe-mode-cause-')); dirs.push(d); return d; };
const T0 = Date.UTC(2026, 10, 6, 23, 12, 0);
const iso = (t: number): string => new Date(t).toISOString();
const HEADER: CrashHeader = { schema: 1, version: '2.0.0-beta.60', build: '2.0.0-beta.60+abc123def456', os: 'linux', osRelease: '6.1.0', arch: 'x64', uptimeS: 42 };

const hang = (at: number): CrashRecord => ({ ...HEADER, kind: 'hang', at: iso(at), windowPid: 9, lastBeatAt: iso(at - 30_000), lifecycle: [], stalls: [], memory: [], agents: [] });
const exit = (at: number, code: number | null): CrashRecord => ({ ...HEADER, kind: 'exit', at: iso(at), pid: 9, reason: code === null ? 'before-quit' : 'exit', code, rssMb: 1, agents: [] });

describe('the cause of the run that did not end cleanly', () => {
    it('the NEWEST record since that run started: a hang, an exit with its code; an older run’s records are not this one’s', () => {
        const crash = fresh();
        // An earlier run's hang, before the run in question started.
        writeCrashRecord(crash, hang(T0 - 60 * 60_000));
        expect(previousRunCause(crash, T0)).toBe('it ended without a trace');
        writeCrashRecord(crash, hang(T0 + 5 * 60_000));
        expect(previousRunCause(crash, T0)).toBe('it stopped responding');
        writeCrashRecord(crash, exit(T0 + 6 * 60_000, 3));
        expect(previousRunCause(crash, T0)).toBe('it exited with code 3');
        writeCrashRecord(crash, exit(T0 + 7 * 60_000, null));
        expect(previousRunCause(crash, T0)).toBe('it ended without a trace');
    });

    it('with no start known (no host.json), or no records at all: without a trace', () => {
        const crash = fresh();
        writeCrashRecord(crash, hang(T0));
        expect(previousRunCause(crash, null)).toBe('it ended without a trace');
        expect(previousRunCause(join(fresh(), 'none'), T0)).toBe('it ended without a trace');
    });
});

describe('safe mode shows it', () => {
    it('a run with no clean-exit marker: the view’s cause is the records’ cause', () => {
        const dir = fresh();
        SafeMode.open(dir, { now: () => T0, pid: 1 }).beat([]);
        const asked: number[] = [];
        const next = SafeMode.open(dir, { now: () => T0 + 60_000, pid: 2, cause: () => { asked.push(1); return 'it stopped responding'; } });
        expect(next.view()).toMatchObject({ active: true, cause: 'it stopped responding' });
        expect(asked).toEqual([1]);
    });

    it('CONTROL: a clean end is not safe mode, and no cause is read', () => {
        const dir = fresh();
        SafeMode.open(dir, { now: () => T0, pid: 1 }).writeCleanExit('a window asked');
        const asked: number[] = [];
        const next = SafeMode.open(dir, { now: () => T0 + 60_000, pid: 2, cause: () => { asked.push(1); return 'it stopped responding'; } });
        expect(next.active()).toBe(false);
        expect(asked).toEqual([]);
    });

    it('genie-host reads the cause from runtime/crash, bounded by the previous host’s start in host.json', () => {
        const src = readFileSync('src/main/genie-host.ts', 'utf8').replace(/\r\n/g, '\n');
        expect(src).toMatch(/SafeMode\.open\(runtime, \{[^\n]*cause: \(\) => previousRunCause\(join\(runtime, 'crash'\), parseHostRecord\(readOrNull\(recordFile\)\)\?\.startedAt \?\? null\)/);
    });
});
