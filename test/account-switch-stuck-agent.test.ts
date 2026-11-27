import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import type { Headroom, ReadingStamp } from '../src/core/headroom.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import { ReadingAttribution } from '../src/core/reading-attribution.js';
import type { DriverEvents, SessionDriver } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * SWITCHING OFF A SPENT ACCOUNT (the owner, 2026-11-26, on beta.66: "ALL FUCKING ACCOUNTS ARE SHARING THE SAME FUCKING 5 HR
 * RATE counter"; "I keep hitting the fucking resume button you keep stopping"). Two faults, one incident:
 *
 * 1. THE AGENT NEVER LEFT THE SPENT ACCOUNT. A switch lifted the agent's limit hold, which flushed its queued message into the
 *    process still running in the SPENT account's directory; that turn hit the limit again and re-held the agent; a held agent
 *    is never quiet, so the move to the new account waited forever. An agent held on the limit has nothing in hand to cut: it
 *    moves at once, and what it queued goes to the new account's process.
 *
 * 2. EVERY ACCOUNT SHOWED THE SPENT ONE'S FIGURES. The stuck run kept reporting the spent account's reading. Each reading started
 *    a read of who is signed in (#854), which HELD the reading and gave it back stamped with the ACTIVE account (#753, written for
 *    one home per provider). With accounts in directories of their own (#1011) a run's account is fixed by its directory, so the
 *    active account is the wrong owner: switch to B, B gets A's 5 h 0 %; switch to C, C gets it too.
 *
 * Fixtures name no person.
 */

const THREAD = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d';
const acct = (suffix: string, configDir?: string): AccountRecord => ({
    id: `account_${suffix.repeat(32)}`, provider: 'claude', label: `Account ${suffix}`, labelEdited: false, home: '/home/.claude', legacy: false,
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-21T00:00:00Z', ...(configDir ? { configDir, method: 'subscription' as const } : {}),
});
const A = acct('1', '/genie/accounts/claude/a');
const B = acct('2', '/genie/accounts/claude/b');
const MIN = 60_000;

const rejected = (now: number) => ({
    sessionUpdate: 'notice', notice: { level: 'info', message: 'You have hit your limit' },
    _meta: { 'particle.academy/rate_limit': { status: 'rejected', rateLimitType: 'five_hour', resetsAtMs: now + 60 * MIN, windows: { five_hour: { utilization: 1, resetsAtMs: now + 60 * MIN }, seven_day: { utilization: 0.36, resetsAtMs: now + 100 * 60 * MIN } }, raw: {} } },
});

interface Driver { prompts: unknown[]; events: DriverEvents; account: AccountRecord | undefined; killed: boolean }

describe('an agent held on a spent account, switched to another', () => {
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-stuck-switch-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    function world() {
        let active: AccountRecord = A;
        const drivers: Driver[] = [];
        const stamps: Array<{ leftPct: number; stamp: ReadingStamp | undefined }> = [];
        let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
        const tree: ProcessTree = {
            snapshot: () => [...processes],
            killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
        };
        const driverFor: DriverFor = (_agent, _cwd, _resume, extras) => ({ events }) => {
            const pid = process.pid + 2_000_000 + drivers.length + 1;
            let running = false;
            const d: Driver = { prompts: [], events, account: extras?.account, killed: false };
            drivers.push(d);
            const driver: SessionDriver = {
                start: () => { running = true; processes.push({ pid, ppid: process.pid, started: 3, name: 'claude-fixture' }); },
                prompt: (content) => { d.prompts.push(content); },
                cancel: () => Promise.resolve(),
                kill: () => { d.killed = true; running = false; processes = processes.filter((p) => p.pid !== pid); },
                get running() { return running; },
                get cliSessionId() { return THREAD; },
            };
            return driver;
        };
        const host = new SessionHost({
            userData: dir, driverFor, processTree: tree, stopGraceMs: 0,
            activeAccount: () => active,
            threadInAccount: () => 'present',
            onHeadroom: (_provider: string, room: Headroom, stamp?: ReadingStamp) => { stamps.push({ leftPct: room.leftPct, stamp }); },
        });
        hosts.push(host);
        const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'atlas' }), threadId: THREAD };
        // What genie-host does on a switch: the book's active account changes, then every agent is told (announceSwitch).
        const switchTo = (a: AccountRecord) => { active = a; host.accountChanged('claude'); host.accountSwitched('claude', { account: a, headroom: null }); };
        return { host, record, drivers, stamps, switchTo };
    }

    const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };

    it('moves to the new account at once, and its queued message goes to the NEW process, never the spent one', async () => {
        const w = world();
        expect(w.host.start(w.record, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        w.drivers[0]!.events.onUpdate?.(rejected(Date.now()));
        await flush();
        w.host.prompt(w.record.id, 'are you there?', 'you');
        // CONTROL: it is held on the limit, and the message waits.
        expect(w.host.probe(w.record.id)?.limit).toMatchObject({ state: 'paused' });
        expect(w.drivers[0]!.prompts).toEqual([]);

        w.switchTo(B);

        await vi.waitFor(() => expect(w.drivers).toHaveLength(2));
        expect(w.drivers[1]!.account?.id).toBe(B.id);
        expect(w.drivers[0]!.killed).toBe(true);
        // The spent account's process was never sent the message: that is the turn that re-held the agent.
        expect(w.drivers[0]!.prompts).toEqual([]);
        await vi.waitFor(() => expect(w.drivers[1]!.prompts.map(String).join('\n')).toContain('are you there?'));
    });

    it('a reading from a run still in the old account\'s own directory is stamped as that account\'s, and pinned to it', async () => {
        const w = world();
        w.host.start(w.record, dir);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        // A turn in hand keeps it on A's process after the switch (the move waits for a clean idle).
        w.host.prompt(w.record.id, 'work', 'you');
        w.switchTo(B);
        w.stamps.length = 0;
        w.drivers[0]!.events.onUpdate?.(rejected(Date.now()));
        await flush();
        const fromRun = w.stamps.filter((s) => s.stamp?.runId !== 'account-switch');
        expect(fromRun.length).toBeGreaterThan(0);
        for (const s of fromRun) expect(s.stamp).toMatchObject({ accountId: A.id, pinned: true });
    });
});

describe('ReadingAttribution: a reading pinned to its run\'s own account is never re-credited to the active one', () => {
    const spent: Headroom = { plan: null, window: '5h', leftPct: 0, resetsAtMs: 9_999_999_999_999, over: true, windows: [
        { window: '5h', usedPct: 100, leftPct: 0, resetsAtMs: 9_999_999_999_999, over: true },
    ] };

    it('while a read of who is signed in is under way, a pinned reading passes at once under its own account, and nothing is held', () => {
        const attribution = new ReadingAttribution();
        attribution.readStart('claude', B.id);
        expect(attribution.stamp('claude', spent, { accountId: A.id, runId: 'run-a', pinned: true })).toEqual({ accountId: A.id, runId: 'run-a', pinned: true });
        expect(attribution.readEnd('claude', B.id).held).toBeNull();
    });

    it('CONTROL (#753): an unpinned reading in that gap is still held and given back under the account then active', () => {
        const attribution = new ReadingAttribution();
        attribution.readStart('claude', B.id);
        expect(attribution.stamp('claude', spent, { accountId: A.id, runId: 'run-a' })).toBeNull();
        expect(attribution.readEnd('claude', B.id).held?.stamp.accountId).toBe(B.id);
    });
});
