import { spawn as spawnChild, ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { makeProcessTree, sameProcess, START_UNKNOWN, systemProcessTree, type ProcessInfo } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';

/**
 * AN AGENT'S START AND STOP NEVER READ THE PROCESS TABLE ON MAIN'S THREAD (beta.53 freezes, measured on genie-test-windows
 * 2026-10-31 with the stall watchdog: main held 2–20 s at a time, back to back, every stack
 * `execFileSync < win32Snapshot < snapshot < aroundSpawn < start` — two PowerShell `Get-CimInstance Win32_Process` readings
 * around every spawn, twice per start for a deferred driver, and one more before every graceful stop. Eleven agents
 * resuming after a restart held the window for minutes; any later start, wake or restart for seconds — Windows'
 * AppHangTransient).
 *
 * Which processes a spawn made is now known EXACTLY without a before/after diff: every child main creates during the
 * synchronous spawn call is that spawn's (nothing else runs on main inside it), captured as it is created. Their start
 * times and descendants come from a reading taken OFF the loop afterwards. A stop waits for that reading, and reads the
 * tree before it ends the provider off the loop too.
 *
 * A tree with only synchronous OS calls (the injected test trees elsewhere) keeps the old synchronous path; this file is
 * the tree Genie actually runs with: `read` and `capture` present, `snapshot` counted and never expected to be called.
 */
const SELF = process.pid;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function asyncTable() {
    let clock = 5_000;
    const rows = new Map<number, ProcessInfo>([[SELF, { pid: SELF, ppid: 1, started: 0, name: 'Genie.exe' }]]);
    let capturing: number[] | null = null;
    let syncReads = 0;
    let asyncReads = 0;
    let readsToFail = 0;
    const kills: number[] = [];
    const tree = makeProcessTree({
        snapshot: () => { syncReads += 1; return [...rows.values()]; },
        killOne: (pid) => { kills.push(pid); rows.delete(pid); },
        snapshotAsync: async () => {
            asyncReads += 1;
            await new Promise((r) => setTimeout(r, 5));
            if (readsToFail > 0) { readsToFail -= 1; throw new Error('the machine could not be read'); }
            return [...rows.values()];
        },
        killOneAsync: async (pid) => { kills.push(pid); rows.delete(pid); },
        captureSpawns: (fn, sink) => {
            const outer = capturing;
            capturing = sink;
            try { fn(); } finally { capturing = outer; }
        },
    });
    return {
        tree,
        /** A process Genie's main creates (a direct child): captured if a capture is running. */
        child: (pid: number, name: string) => { rows.set(pid, { pid, ppid: SELF, started: (clock += 10), name }); capturing?.push(pid); },
        /** A process another process creates. */
        grandchild: (pid: number, ppid: number, name: string) => { rows.set(pid, { pid, ppid, started: (clock += 10), name }); },
        exit: (pid: number) => { rows.delete(pid); },
        alive: (pid: number) => rows.has(pid),
        syncReads: () => syncReads,
        asyncReads: () => asyncReads,
        failNextReads: (n: number) => { readsToFail = n; },
        kills: () => [...kills],
    };
}

function claudeLike(t: ReturnType<typeof asyncTable>, pidBase: number, log: string[]) {
    let events: DriverEvents = {};
    let exited = false;
    const factory: SessionDriverFactory = (o) => {
        events = o.events;
        const driver: SessionDriver & { endInput(): void } = {
            start: () => { t.child(pidBase, 'supervisor.exe'); t.grandchild(pidBase + 1, pidBase, 'claude.exe'); log.push('start'); },
            prompt: () => {},
            endInput: () => { log.push('endInput'); setTimeout(() => { if (exited) return; exited = true; t.exit(pidBase + 1); t.exit(pidBase); events.onExit?.(0, null); }, 20); },
            kill: () => { log.push('kill'); t.exit(pidBase); },
            get running() { return !exited; },
            cliSessionId: '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d',
        };
        return driver;
    };
    return { factory };
}

function session(t: ReturnType<typeof asyncTable>, factory: SessionDriverFactory, onSpawned?: (m: readonly ProcessInfo[]) => void): AgentSession {
    const dir = mkdtempSync(join(tmpdir(), 'genie-spawn-async-'));
    dirs.push(dir);
    return new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: t.tree, ...(onSpawned ? { onSpawned } : {}) });
}

describe('A READING THAT FAILS: nothing started goes unrecorded', () => {
    const until = async (what: string, done: () => boolean) => {
        const deadline = Date.now() + 10_000;
        while (!done()) {
            if (Date.now() > deadline) throw new Error(`not within 10 s: ${what}`);
            await new Promise((r) => setTimeout(r, 5));
        }
    };
    function started(failures: number) {
        const t = asyncTable();
        t.failNextReads(failures);
        const spawned: Array<readonly ProcessInfo[]> = [];
        const failed: Array<readonly number[]> = [];
        const dir = mkdtempSync(join(tmpdir(), 'genie-spawn-async-'));
        dirs.push(dir);
        const s = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: claudeLike(t, 960_000, []).factory, processTree: t.tree,
            onSpawned: (m) => spawned.push(m), onReadingFailed: (pids) => failed.push(pids),
        });
        s.start();
        return { t, s, spawned, failed };
    }

    it('one failure is tried again, and the record is the real one, with nothing said', async () => {
        const r = started(1);
        await until('the record', () => r.spawned.length > 0);
        expect(r.t.asyncReads()).toBeGreaterThanOrEqual(2);
        expect(r.spawned.at(-1)?.map((p) => p.pid).sort()).toEqual([960_000, 960_001]);
        expect(r.spawned.at(-1)?.every((p) => p.started !== START_UNKNOWN)).toBe(true);
        expect(r.failed).toEqual([]);
    });

    it('still no reading: the pid the spawn made is recorded, marked start time unknown, and it is said', async () => {
        const r = started(2);
        await until('the mark', () => r.spawned.length > 0);
        expect(r.spawned.at(-1)).toEqual([expect.objectContaining({ pid: 960_000, started: START_UNKNOWN })]);
        expect(r.failed).toEqual([[960_000]]);
    });

    it('the mark can match no process: not even the real one with that pid', async () => {
        const r = started(2);
        await until('the mark', () => r.spawned.length > 0);
        const table = await r.t.tree.read!();
        const real = table!.find((p) => p.pid === 960_000)!;
        expect(sameProcess(r.spawned.at(-1)![0]!, real)).toBe(false);
    });

    it('its stop cannot verify, says so, and kills only through the driver: a pid with no start time is not reaped', async () => {
        const r = started(2);
        await until('the mark', () => r.spawned.length > 0);
        const verdict = await r.s.stop('SIGTERM', { graceMs: 0 });
        expect(verdict).toMatchObject({ verified: false });
        expect(r.t.kills(), 'the reap took nothing it could not name').toEqual([]);
    });
});

describe('a start on the real tree: no synchronous reading; the spawn’s own processes, exactly', () => {
    it('start reads nothing on the loop; the reading after names the spawn’s child and its tree, and not a sibling started just after', async () => {
        const t = asyncTable();
        const log: string[] = [];
        const spawned: Array<readonly ProcessInfo[]> = [];
        /*
         * WAITED FOR, NOT SLEPT ON (2026-11-01). The reading lands after two timers (the shared reader's pump, the table's
         * 5 ms), and this waited a fixed 50 ms for it: on omarchy-test under the full suite (load 9–13 on 2 vCPU) the
         * timers ran late and `spawned` was still empty — a red that named nothing about a spawn. Now the test waits for
         * the reading itself; one that never lands fails by name at the deadline.
         */
        let landed!: () => void;
        const reading = new Promise<void>((r) => { landed = r; });
        const s = session(t, claudeLike(t, 910_000, log).factory, (m) => { spawned.push(m); landed(); });
        s.start();
        // Another agent's provider, created by main right after this start returned (the boot burst).
        t.child(920_000, 'other-supervisor.exe');
        expect(t.syncReads()).toBe(0);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const never = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('the reading after the start never landed (10 s)')), 10_000); });
        try { await Promise.race([reading, never]); } finally { clearTimeout(deadline); }
        expect(t.syncReads()).toBe(0);
        expect(t.asyncReads()).toBeGreaterThan(0);
        expect(spawned.at(-1)?.map((p) => p.pid).sort(), 'the spawn’s own processes, from the reading after').toEqual([910_000, 910_001]);
    }, 30_000);

    it('a graceful stop reads off the loop, closes stdin, verifies the end — and never touches the sibling', async () => {
        const t = asyncTable();
        const log: string[] = [];
        const s = session(t, claudeLike(t, 930_000, log).factory);
        s.start();
        t.child(940_000, 'other-supervisor.exe');
        await new Promise((r) => setTimeout(r, 30));
        const verdict = await s.stop('SIGTERM', { graceMs: 2_000 });
        expect(verdict).toMatchObject({ verified: true });
        expect(log).toContain('endInput');
        expect(t.alive(930_001)).toBe(false);
        expect(t.alive(940_000)).toBe(true);
        expect(t.kills()).not.toContain(940_000);
        expect(t.syncReads()).toBe(0);
    });

    it('a stop asked before the start’s reading has landed still ends the spawn’s tree, verified', async () => {
        const t = asyncTable();
        const log: string[] = [];
        const s = session(t, claudeLike(t, 950_000, log).factory);
        s.start();
        const verdict = await s.stop('SIGTERM', { graceMs: 2_000 });
        expect(verdict).toMatchObject({ verified: true });
        expect(t.alive(950_000)).toBe(false);
        expect(t.alive(950_001)).toBe(false);
        expect(t.syncReads()).toBe(0);
    });
});

describe('the system tree’s capture: the children main creates inside the call, and only those', () => {
    it('records a real child spawned inside it, not one spawned outside; ChildProcess is left as it was', async () => {
        const before = (ChildProcess.prototype as unknown as { spawn: unknown }).spawn;
        const inside: number[] = [];
        let made: ChildProcess | null = null;
        expect(typeof systemProcessTree.capture).toBe('function');
        systemProcessTree.capture!(() => { made = spawnChild(process.execPath, ['-e', 'setTimeout(()=>{},300)']); }, inside);
        const outside = spawnChild(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
        expect(inside).toEqual([made!.pid]);
        expect(inside).not.toContain(outside.pid);
        expect((ChildProcess.prototype as unknown as { spawn: unknown }).spawn).toBe(before);
        await Promise.all([made!, outside].map((c) => new Promise((r) => c.once('exit', r))));
    });

    it('a spawn that throws still leaves ChildProcess as it was, and what it made before the throw is kept', () => {
        const before = (ChildProcess.prototype as unknown as { spawn: unknown }).spawn;
        const sink: number[] = [];
        expect(() => systemProcessTree.capture!(() => { spawnChild(process.execPath, ['-e', '']); throw new Error('boom'); }, sink)).toThrow('boom');
        expect(sink).toHaveLength(1);
        expect((ChildProcess.prototype as unknown as { spawn: unknown }).spawn).toBe(before);
    });
});

describe('boot reads the machine off the loop', () => {
    it('the v1 reap and the leftover-provider sweep use the asynchronous listings', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        const reap = main.slice(main.indexOf('async function reapV1Runtime'), main.indexOf('\n}\n', main.indexOf('async function reapV1Runtime')));
        expect(reap).toMatch(/await listProcessesAsync\(\)/);
        expect(reap).not.toMatch(/listProcesses\(\)/);
        expect(main).toMatch(/await sweepLeftoverProvidersAsync\(/);
        expect(main).not.toMatch(/[^.]sweepLeftoverProviders\(/);
    });
});
