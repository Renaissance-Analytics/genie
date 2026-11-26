import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileLockIdentityStatus, warmLockIdentity } from '@particle-academy/prism-harness';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriver } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * AN OVERLOADED AGENT THAT EXITED WHILE GENIE WAITED (Tynn #1060; prism-acp 0.48.0: "if the agent exits, the retry fails
 * with session_exited; reload with session/load"). Genie drives prism's drivers in-process, so its reload is its own
 * restart on the same conversation (the record's thread, as an unconfirmed interrupt's restart uses), and then the failed
 * prompt is resent to the new run, once.
 */

beforeAll(async () => {
    await warmLockIdentity();
    console.log(`[#1060] ${process.platform} lock identity read once: ${Math.round(fileLockIdentityStatus().sample_duration_ms)} ms`);
}, 30_000);

const CLAUDE_529 = { stopReason: null, isError: true, raw: 'error', failure: { reason: 'server_error', kind: 'overloaded', retryable: true, resumable: true } };

describe('SessionHost: an overloaded agent that exited during the wait', () => {
    const THREAD = '5d1f0c2a-7b3e-4c9d-8a61-2f0e1a3b4c6d';
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-overload-exit-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    interface Driver { prompts: unknown[]; events: DriverEvents; exit: () => void }
    function world() {
        const drivers: Driver[] = [];
        const resumedWith: Array<string | null> = [];
        const timers: Array<{ ms: number; fire: () => void }> = [];
        let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
        const tree: ProcessTree = {
            snapshot: () => [...processes],
            killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
        };
        const driverFor: DriverFor = (_agent, _cwd, resume) => {
            resumedWith.push(resume);
            return ({ events }) => {
                const pid = process.pid + 3_000_000 + drivers.length + 1;
                let running = false;
                const d: Driver = {
                    prompts: [], events,
                    exit: () => { running = false; processes = processes.filter((p) => p.pid !== pid); events.onExit?.(1, null); },
                };
                drivers.push(d);
                const driver: SessionDriver = {
                    start: () => { running = true; processes.push({ pid, ppid: process.pid, started: 3, name: 'claude-fixture' }); },
                    prompt: (content) => { if (!running) throw new Error('driver exited'); d.prompts.push(content); },
                    cancel: () => Promise.resolve(),
                    kill: () => { running = false; processes = processes.filter((p) => p.pid !== pid); },
                    get running() { return running; },
                    get cliSessionId() { return THREAD; },
                };
                return driver;
            };
        };
        const retryLater = (ms: number, fire: () => void) => {
            const timer = { ms, fire }; timers.push(timer);
            return () => { const i = timers.indexOf(timer); if (i !== -1) timers.splice(i, 1); };
        };
        const host = new SessionHost({ userData: dir, driverFor, processTree: tree, stopGraceMs: 0, retryLater } as ConstructorParameters<typeof SessionHost>[0]);
        hosts.push(host);
        const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'moic' }), threadId: THREAD };
        return { host, record, drivers, resumedWith, timers };
    }

    it('at the retry the agent starts again on the same conversation and the failed prompt is sent to it, once', async () => {
        const w = world();
        w.host.start(w.record, dir);
        w.host.prompt(w.record.id, 'build it', 'you');
        w.drivers[0]!.events.onTurnEnd?.(CLAUDE_529 as never);
        w.drivers[0]!.exit();
        expect(w.timers).toHaveLength(1);
        w.timers[0]!.fire();
        await vi.waitFor(() => expect(w.drivers).toHaveLength(2), { timeout: 3_000 });
        expect(w.resumedWith).toEqual([THREAD, THREAD]);
        await vi.waitFor(() => expect(w.drivers[1]!.prompts).toEqual(['build it']), { timeout: 3_000 });
        expect(w.drivers[0]!.prompts).toEqual(['build it']);
    });

    it('CONTROL: an agent the person stopped during the wait is not started again', async () => {
        const w = world();
        w.host.start(w.record, dir);
        w.host.prompt(w.record.id, 'build it', 'you');
        w.drivers[0]!.events.onTurnEnd?.(CLAUDE_529 as never);
        w.host.stop(w.record.id, { graceful: false });
        await w.host.ended(w.record.id);
        expect(w.timers).toEqual([]);
        expect(w.drivers).toHaveLength(1);
    });
});
