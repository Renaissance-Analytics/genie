import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { makeProcessTree, type ProcessInfo, type ProcessTreeIo } from '../src/core/process-tree.js';
import { AgentSession, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';

/**
 * A STOP THAT LEAVES THE WINDOW ANSWERING (genie#1201). With a tree that reads asynchronously (Genie's own), a stop's
 * reading, reap and verification run off main's event loop: `stop()` returns before the first reading has come back,
 * nothing reads synchronously, and the rules are the ones the synchronous stop keeps (session-stop-orphans.test.ts):
 * the tree is read BEFORE the kill — the kill is what orphans — every process of the run is ended, and a fresh reading
 * verifies it, naming a survivor rather than claiming success.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const SELF = process.pid;
const CMD = 910_001;
const PROVIDER = 910_002;
const TOOL = 910_003;

/** A fake process table whose ASYNC readings resolve only when the test releases them (or at once, `auto`). */
function asyncTable() {
    let clock = 1_000;
    const rows = new Map<number, ProcessInfo>();
    const put = (pid: number, ppid: number, name: string): void => { rows.set(pid, { pid, ppid, started: (clock += 10), name }); };
    put(SELF, 1, 'Genie.exe');
    const events: string[] = [];
    const waiting: Array<() => void> = [];
    const unkillable = new Set<number>();
    let auto = false;
    let broken = false;
    let syncReads = 0;
    let asyncReads = 0;
    const io: ProcessTreeIo = {
        snapshot: () => { syncReads += 1; return [...rows.values()]; },
        killOne: (pid) => { events.push(`sync-kill ${pid}`); if (!unkillable.has(pid)) rows.delete(pid); },
        snapshotAsync: () => new Promise<ProcessInfo[]>((resolve, reject) => {
            asyncReads += 1;
            const go = () => { events.push('read'); if (broken) reject(new Error('WMI unavailable')); else resolve([...rows.values()]); };
            if (auto) setTimeout(go, 0); else waiting.push(go);
        }),
        killOneAsync: async (pid) => { events.push(`kill ${pid}`); if (!unkillable.has(pid)) rows.delete(pid); },
    };
    return {
        tree: makeProcessTree(io), put, events, rows,
        release: () => { const w = waiting.splice(0); for (const go of w) go(); return w.length; },
        auto: () => { auto = true; for (const go of waiting.splice(0)) go(); },
        unkillable: (pid: number) => { unkillable.add(pid); },
        breakReads: () => { broken = true; },
        syncReads: () => syncReads,
        asyncReads: () => asyncReads,
    };
}

function session(t: ReturnType<typeof asyncTable>, onKill: () => void): AgentSession {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-stop-async-'));
    dirs.push(dir);
    const driverFactory: SessionDriverFactory = () => ({
        start: () => { t.put(CMD, SELF, 'cmd.exe'); t.put(PROVIDER, CMD, 'claude.exe'); },
        prompt: () => {},
        kill: () => { t.events.push('driver-kill'); onKill(); },
        cliSessionId: null,
    });
    return new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory, processTree: t.tree });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('a stop with Genie’s asynchronous tree', () => {
    it('returns before any reading has come back, and reads nothing synchronously', async () => {
        const t = asyncTable();
        const s = session(t, () => { t.rows.delete(CMD); });
        s.start();
        const startReads = t.syncReads();
        t.put(TOOL, PROVIDER, 'node.exe'); // a tool the provider started after the session began
        const stopping = s.stop('SIGTERM', { graceMs: 0 });
        expect(s.stopVerdict).toBeNull();
        expect(t.events).toEqual([]); // nothing killed yet: the tree is read FIRST
        await tick();
        expect(t.syncReads()).toBe(startReads);
        t.auto();
        const verdict = await stopping;
        expect(verdict).toEqual({ verified: true, ended: 3 });
        // The reading came BEFORE the kill, and the kill orphaned what the reap then ended.
        expect(t.events.indexOf('read')).toBeLessThan(t.events.indexOf('driver-kill'));
        expect(t.rows.has(PROVIDER)).toBe(false);
        expect(t.rows.has(TOOL)).toBe(false);
        expect(t.syncReads()).toBe(startReads);
        expect(t.events.some((e) => e.startsWith('sync-kill'))).toBe(false);
    });

    it('a process that will not go makes the verdict UNVERIFIED, naming it — never a success', async () => {
        const t = asyncTable();
        const s = session(t, () => { t.rows.delete(CMD); });
        s.start();
        const startReads = t.syncReads();
        t.unkillable(PROVIDER);
        t.auto();
        const verdict = await s.stop('SIGTERM', { graceMs: 0 });
        expect(verdict.verified).toBe(false);
        expect(verdict.verified === false && verdict.reason).toContain(`${PROVIDER}(claude.exe)`);
        // Found by the asynchronous readings, not the synchronous ones.
        expect(t.syncReads()).toBe(startReads);
        expect(t.asyncReads()).toBeGreaterThan(1);
    });

    it('a machine it cannot read is said, not read as "nothing running"', async () => {
        const t = asyncTable();
        const s = session(t, () => {});
        s.start();
        t.breakReads();
        t.auto();
        const verdict = await s.stop('SIGTERM', { graceMs: 0 });
        expect(verdict.verified).toBe(false);
        expect(verdict.verified === false && verdict.reason).toMatch(/could not read/);
    });

    it('ten agents stopped together share their readings: a handful, not one per step per agent', async () => {
        const t = asyncTable();
        const sessions = Array.from({ length: 10 }, (_, i) => {
            const cmd = 920_000 + i * 10;
            const dir = mkdtempSync(join(tmpdir(), 'genie2-stop-async-'));
            dirs.push(dir);
            const factory: SessionDriverFactory = () => ({
                start: () => { t.put(cmd, SELF, 'cmd.exe'); t.put(cmd + 1, cmd, 'claude.exe'); },
                prompt: () => {}, kill: () => { t.rows.delete(cmd); }, cliSessionId: null,
            });
            return new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: t.tree });
        });
        for (const s of sessions) s.start();
        const startReads = t.syncReads();
        t.auto();
        const verdicts = await Promise.all(sessions.map((s) => s.stop('SIGTERM', { graceMs: 0 })));
        expect(verdicts.every((v) => v.verified)).toBe(true);
        // Synchronously this was at least 20 readings on main (one before and one after each kill); now none on main,
        // and a handful off it.
        expect(t.syncReads()).toBe(startReads);
        expect(t.asyncReads()).toBeGreaterThan(0);
        expect(t.asyncReads()).toBeLessThanOrEqual(4);
    });
});
