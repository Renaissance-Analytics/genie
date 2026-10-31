import { spawn as spawnChild, ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { makeProcessTree, systemProcessTree, type ProcessInfo } from '../src/core/process-tree.js';
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
    const kills: number[] = [];
    const tree = makeProcessTree({
        snapshot: () => { syncReads += 1; return [...rows.values()]; },
        killOne: (pid) => { kills.push(pid); rows.delete(pid); },
        snapshotAsync: async () => { asyncReads += 1; await new Promise((r) => setTimeout(r, 5)); return [...rows.values()]; },
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

describe('a start on the real tree: no synchronous reading; the spawn’s own processes, exactly', () => {
    it('start reads nothing on the loop; the reading after names the spawn’s child and its tree, and not a sibling started just after', async () => {
        const t = asyncTable();
        const log: string[] = [];
        const spawned: Array<readonly ProcessInfo[]> = [];
        const s = session(t, claudeLike(t, 910_000, log).factory, (m) => spawned.push(m));
        s.start();
        // Another agent's provider, created by main right after this start returned (the boot burst).
        t.child(920_000, 'other-supervisor.exe');
        expect(t.syncReads()).toBe(0);
        await new Promise((r) => setTimeout(r, 50));
        expect(t.syncReads()).toBe(0);
        expect(t.asyncReads()).toBeGreaterThan(0);
        expect(spawned.at(-1)?.map((p) => p.pid).sort()).toEqual([910_000, 910_001]);
    });

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
        const before = ChildProcess.prototype.spawn;
        const inside: number[] = [];
        let made: ChildProcess | null = null;
        expect(typeof systemProcessTree.capture).toBe('function');
        systemProcessTree.capture!(() => { made = spawnChild(process.execPath, ['-e', 'setTimeout(()=>{},300)']); }, inside);
        const outside = spawnChild(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
        expect(inside).toEqual([made!.pid]);
        expect(inside).not.toContain(outside.pid);
        expect(ChildProcess.prototype.spawn).toBe(before);
        await Promise.all([made!, outside].map((c) => new Promise((r) => c.once('exit', r))));
    });

    it('a spawn that throws still leaves ChildProcess as it was, and what it made before the throw is kept', () => {
        const before = ChildProcess.prototype.spawn;
        const sink: number[] = [];
        expect(() => systemProcessTree.capture!(() => { spawnChild(process.execPath, ['-e', '']); throw new Error('boom'); }, sink)).toThrow('boom');
        expect(sink).toHaveLength(1);
        expect(ChildProcess.prototype.spawn).toBe(before);
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
