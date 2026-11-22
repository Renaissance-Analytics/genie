import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import { COOLING_MS, type DriverEvents, type SessionDriver, type TurnOutcomeLike } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A SWITCH REACHES A RUNNING AGENT AT ITS NEXT CLEAN IDLE (Tynn #1011). The owner: "agents keep running when we switch.
 * provider accounts never dictate agent operations, only rate limits." A running `claude` has its CLAUDE_CONFIG_DIR fixed at
 * spawn, so the new account is reached by starting the agent's process again on the SAME thread, between turns. Never while
 * a turn, a tool, an approval or a queued message is in hand; never a new thread; invisible (no start sound, no run row the
 * person reads as a new session); and a re-spawn that cannot come up leaves the agent on its old account, said once.
 */

const THREAD = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d';
const REPLIED: TurnOutcomeLike = { stopReason: 'end_turn', isError: false, raw: 'end_turn' };
const acct = (suffix: string, configDir?: string): AccountRecord => ({
    id: `account_${suffix.repeat(32)}`, provider: 'claude', label: `Account ${suffix}`, labelEdited: false, home: '/home/.claude', legacy: false,
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-21T00:00:00Z', ...(configDir ? { configDir, method: 'subscription' as const } : {}),
});
const A = acct('1');
const B = acct('2', '/genie/accounts/claude/b');

describe('SessionHost: the active Claude account changes under a running agent', () => {
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-1011-respawn-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    interface Driver { prompts: unknown[]; events: DriverEvents; account: AccountRecord | undefined; resume: string | null; killed: boolean }
    function world(opts: { store?: 'present' | 'absent' | 'indeterminate'; failOn?: string } = {}) {
        let active: AccountRecord = A;
        const drivers: Driver[] = [];
        const actions: string[] = [];
        const probed: Array<{ threadId: string; configDir: string | null }> = [];
        let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
        const tree: ProcessTree = {
            snapshot: () => [...processes],
            killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
        };
        const driverFor: DriverFor = (_agent, _cwd, resume, extras) => ({ events }) => {
            const pid = process.pid + 1_000_000 + drivers.length + 1;
            let running = false;
            const d: Driver = { prompts: [], events, account: extras?.account, resume, killed: false };
            drivers.push(d);
            const driver: SessionDriver = {
                start: () => {
                    if (opts.failOn !== undefined && extras?.account?.id === opts.failOn) throw new Error('the CLI did not come up');
                    running = true; processes.push({ pid, ppid: process.pid, started: 3, name: 'claude-fixture' });
                },
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
            onAction: (_id, kind) => { actions.push(kind); },
            threadInAccount: (threadId, configDir) => { probed.push({ threadId, configDir }); return opts.store ?? 'present'; },
        });
        hosts.push(host);
        const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'atlas' }), threadId: THREAD };
        const switchTo = (a: AccountRecord) => { active = a; host.accountChanged('claude'); };
        const notices = () => host.rowsFor(record.id).map((r) => r.event).filter((e) => e.kind === 'notice').map((e) => (e as { message: string }).message);
        return { host, record, drivers, actions, probed, switchTo, notices };
    }

    it('an IDLE agent is started again on the new account, on the same thread, with no start sound and no visible run row', async () => {
        const w = world();
        expect(w.host.start(w.record, dir)).toEqual({ ok: true });
        expect(w.drivers[0]!.account?.id).toBe(A.id);
        // The gauge can see a run row: a resumed start shows one.
        await vi.waitFor(() => expect(w.host.ledgerFor(w.record.id).filter((r) => r.event.kind === 'run')).toHaveLength(1));
        w.actions.length = 0;
        w.switchTo(B);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(2));
        expect(w.drivers[0]!.killed).toBe(true);
        expect(w.drivers[1]!.account?.id).toBe(B.id);
        expect(w.drivers[1]!.resume).toBe(THREAD);
        // It looked for the thread under B's directory before it stopped anything.
        expect(w.probed).toEqual([{ threadId: THREAD, configDir: B.configDir }]);
        expect(w.actions).not.toContain('started');
        // No "Run started" row for the move. The positive control is the test above it: the run it moved from showed one.
        await vi.waitFor(() => expect(w.host.historyPending(w.record.id)).toBe(false));
        expect(w.host.ledgerFor(w.record.id).filter((r) => r.event.kind === 'run')).toEqual([]);
        expect(w.notices()).toEqual([]);
    });

    /** Steps the faked clock until `done`, letting what each timer starts run (the move awaits a stop, then starts). */
    const stepUntil = async (done: () => boolean, maxMs: number) => { for (let t = 0; t < maxMs && !done(); t += 50) await vi.advanceTimersByTimeAsync(50); };

    it('a BUSY agent finishes its turn on the old account, and moves only once it is quiet (its turn and Cooling over)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const w = world();
            w.host.start(w.record, dir);
            expect(w.host.prompt(w.record.id, 'work', 'you')).toBe(true);
            w.switchTo(B);
            await vi.advanceTimersByTimeAsync(100);
            expect(w.drivers).toHaveLength(1);
            expect(w.drivers[0]!.killed).toBe(false);
            w.drivers[0]!.events.onTurnEnd?.(REPLIED);
            // COOLING: Claude may still open a turn for a prompt it took mid-turn. Nothing moves in it.
            await vi.advanceTimersByTimeAsync(COOLING_MS - 1_000);
            expect(w.drivers).toHaveLength(1);
            expect(w.drivers[0]!.killed).toBe(false);
            await stepUntil(() => w.drivers.length === 2, 5_000);
            expect(w.drivers).toHaveLength(2);
            expect(w.drivers[1]!.account?.id).toBe(B.id);
            expect(w.drivers[1]!.resume).toBe(THREAD);
        } finally { vi.useRealTimers(); }
    });

    it('a message taken behind the turn is kept: it runs on the old account first, then the agent moves, with nothing sent twice', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const w = world();
            w.host.start(w.record, dir);
            w.host.prompt(w.record.id, 'work', 'you');
            w.host.prompt(w.record.id, 'and then this', 'you');
            w.switchTo(B);
            w.drivers[0]!.events.onTurnEnd?.(REPLIED);
            await vi.advanceTimersByTimeAsync(100);
            // The second message went to the running process: nothing dropped, nothing moved while it runs.
            expect(w.drivers).toHaveLength(1);
            expect(w.drivers[0]!.prompts).toEqual(['work', 'and then this']);
            w.drivers[0]!.events.onTurnEnd?.(REPLIED);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(w.drivers).toHaveLength(1);
            await stepUntil(() => w.drivers.length === 2, COOLING_MS + 5_000);
            expect(w.drivers).toHaveLength(2);
            expect(w.drivers[1]!.prompts).toEqual([]);
        } finally { vi.useRealTimers(); }
    });

    it('a thread the new account cannot find is never forked: the agent stays on its old process and account, told once', async () => {
        const w = world({ store: 'absent' });
        w.host.start(w.record, dir);
        w.switchTo(B);
        await new Promise((r) => setTimeout(r, 20));
        expect(w.drivers).toHaveLength(1);
        expect(w.drivers[0]!.killed).toBe(false);
        w.host.accountChanged('claude');
        await new Promise((r) => setTimeout(r, 20));
        const said = w.notices().filter((m) => m.includes(B.label));
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/keeps running on Account 1/);
    });

    it('a re-spawn that fails to come up puts the agent back on its old account and thread, said, never a new thread', async () => {
        const w = world({ failOn: B.id });
        w.host.start(w.record, dir);
        w.switchTo(B);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(3));
        expect(w.drivers[2]!.account?.id).toBe(A.id);
        expect(w.drivers.map((d) => d.resume)).toEqual([THREAD, THREAD, THREAD]);
        expect(w.host.probe(w.record.id)?.running).toBe(true);
        expect(w.notices().some((m) => m.includes(B.label) && /keeps running on Account 1/.test(m))).toBe(true);
    });
});
