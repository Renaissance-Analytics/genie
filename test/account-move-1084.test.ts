import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { switchNoteFor } from '../src/core/account-switch.js';
import type { AccountRecord } from '../src/core/accounts.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriver } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A SWITCH SAYS WHERE EACH AGENT REALLY IS (Tynn #1084; the owner, beta.66.1). He switched to an account; his busy coordinator
 * was told "Account switched to <new>" and went on running on the OLD account's folder, because an agent moves only at a
 * clean idle and a busy one never has one. Nothing said so. Now: the agent is told it is still on the old account until it
 * is idle; its row says which account it is on and where it moves; the panel counts the agents still on another account;
 * "Restart on <new> now" moves them at once, on their own thread; and an account's first use is reported so its usage can
 * be read.
 */
const THREAD = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d';
const acct = (suffix: string, configDir: string): AccountRecord => ({
    id: `account_${suffix.repeat(32)}`, provider: 'claude', label: `Account ${suffix}`, labelEdited: false, home: '/home/.claude', legacy: false,
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-21T00:00:00Z', configDir, method: 'subscription',
});
const A = acct('1', '/genie/accounts/claude/a');
const B = acct('2', '/genie/accounts/claude/b');

interface Driver { prompts: unknown[]; events: DriverEvents; account: AccountRecord | undefined; killed: boolean; resume: string | null }

describe('switchNoteFor: what an agent is told on a switch', () => {
    it('an agent that moves now is told the switch, as before', () => {
        expect(switchNoteFor({ to: 'Account 2', from: 'Account 1', movesLater: false, headroom: null, nowMs: 0 })).toMatch(/^Account switched to Account 2/);
    });
    it('an agent still on the old account is told it stays there until it is idle, then continues on the new one', () => {
        const note = switchNoteFor({ to: 'Account 2', from: 'Account 1', movesLater: true, headroom: null, nowMs: 0 });
        expect(note).toMatch(/still running on Account 1/);
        expect(note).toMatch(/until (its|your) current work is idle/);
        expect(note).toMatch(/then .*Account 2/);
        expect(note).not.toMatch(/^Account switched to/);
    });
});

/** The host, its fake drivers and the book's active account (A, then whatever a switch makes it). */
function makeWorld(dir: string, hosts: SessionHost[], store: 'present' | 'absent' | 'indeterminate' = 'present', onMovesChanged?: () => void) {
    let active: AccountRecord = A;
    const drivers: Driver[] = [];
    const used: string[] = [];
    let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
    const tree: ProcessTree = {
        snapshot: () => [...processes],
        killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
    };
    const driverFor: DriverFor = (_agent, _cwd, resume, extras) => ({ events }) => {
        const pid = process.pid + 3_000_000 + drivers.length + 1;
        let running = false;
        const d: Driver = { prompts: [], events, account: extras?.account, killed: false, resume: resume ?? null };
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
        threadInAccount: () => store,
        onAccountUsed: (account: AccountRecord) => { used.push(account.id); },
        ...(onMovesChanged ? { onMovesChanged } : {}),
    });
    hosts.push(host);
    const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'atlas' }), threadId: THREAD };
    const switchTo = (a: AccountRecord) => { active = a; host.accountChanged('claude'); host.accountSwitched('claude', { account: a, headroom: null }); };
    return { host, record, drivers, used, switchTo };
}

describe('an agent busy on the old account after a switch', () => {
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-1084-move-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    const world = (store: 'present' | 'absent' | 'indeterminate' = 'present') => makeWorld(dir, hosts, store);
    const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };

    async function busyAfterSwitch() {
        const w = world();
        expect(w.host.start(w.record, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        // A turn in hand: the move waits for a clean idle.
        w.host.prompt(w.record.id, 'work', 'you');
        w.switchTo(B);
        await flush();
        return w;
    }

    it('its row names the account it is on, and the one it moves to', async () => {
        const w = await busyAfterSwitch();
        expect(w.drivers).toHaveLength(1);
        expect(w.host.probe(w.record.id)?.account).toEqual({ id: A.id, label: 'Account 1', movesTo: { id: B.id, label: 'Account 2' } });
    });

    it('CONTROL: an agent on the active account names it, with nowhere to move', async () => {
        const w = world();
        w.host.start(w.record, dir);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        expect(w.host.probe(w.record.id)?.account).toEqual({ id: A.id, label: 'Account 1' });
    });

    it('the panel is told how many agents are still on another account than the active one', async () => {
        const w = await busyAfterSwitch();
        expect(w.host.stillOn('claude')).toEqual([{ accountId: A.id, label: 'Account 1', count: 1 }]);
    });

    it('"Restart on <new> now" moves a busy agent at once, on its own thread, to the active account', async () => {
        const w = await busyAfterSwitch();
        expect(w.host.moveNow('claude')).toBe(1);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(2));
        expect(w.drivers[0]!.killed).toBe(true);
        expect(w.drivers[1]!.account?.id).toBe(B.id);
        await vi.waitFor(() => expect(w.host.probe(w.record.id)?.account).toEqual({ id: B.id, label: 'Account 2' }));
        expect(w.host.stillOn('claude')).toEqual([]);
    });

    it('CONTROL: without the explicit go the busy agent stays where it is', async () => {
        const w = await busyAfterSwitch();
        await flush();
        expect(w.drivers).toHaveLength(1);
        expect(w.drivers[0]!.killed).toBe(false);
    });

    it('an account\'s first use is reported, so its usage can be read (and the new account\'s, when an agent moves to it)', async () => {
        const w = await busyAfterSwitch();
        expect(w.used).toEqual([A.id]);
        w.host.moveNow('claude');
        await vi.waitFor(() => expect(w.used).toEqual([A.id, B.id]));
    });
});

/**
 * AN AGENT THAT CANNOT MOVE SAYS SO (Tynn #1084, the coordinator's review). When its conversation cannot be opened on the new
 * account (it is not in that account's history), the move at its next idle never happens. "Moves at next idle" would then be
 * the very screen this story fixes. So it says it STAYS on the old account and why, in plain words, and "Restart on <active>
 * now" starts it fresh there, a new conversation, only as the person's explicit choice.
 */
describe('an agent whose conversation cannot move to the new account', () => {
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-1084-stays-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });
    const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0)); };

    async function stayingAfterSwitch(store: 'absent' | 'indeterminate' = 'absent') {
        const w = makeWorld(dir, hosts, store);
        expect(w.host.start(w.record, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        // Idle: the switch asks it to move now, and its conversation is not where the new account can open it.
        w.switchTo(B);
        await new Promise((r) => setTimeout(r, 20));
        return w;
    }

    it('it says it stays on the old account, and why, in plain words', async () => {
        const w = await stayingAfterSwitch();
        expect(w.drivers).toHaveLength(1);
        const account = w.host.probe(w.record.id)?.account;
        expect(account).toMatchObject({ id: A.id, label: 'Account 1', stays: { id: B.id, label: 'Account 2' } });
        expect(account?.movesTo).toBeUndefined();
        expect(account?.stays?.why).toBe("its conversation can't be opened on Account 2");
    });

    it('the windows are told when an agent turns out to stay, so an open panel shows it (not a stale "until idle")', async () => {
        let told = 0;
        const w = makeWorld(dir, hosts, 'absent', () => { told += 1; });
        w.host.start(w.record, dir);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        const before = told;
        w.switchTo(B);
        await vi.waitFor(() => expect(w.host.stillOn('claude')[0]?.stays).toBeDefined());
        expect(told).toBeGreaterThan(before);
    });

    it('when Genie cannot tell, it says that, never a guess', async () => {
        const w = await stayingAfterSwitch('indeterminate');
        expect(w.host.probe(w.record.id)?.account?.stays?.why).toBe('Genie could not tell whether Account 2 can open its conversation');
    });

    it('the panel counts it as staying, with the reason', async () => {
        const w = await stayingAfterSwitch();
        expect(w.host.stillOn('claude')).toEqual([{ accountId: A.id, label: 'Account 1', count: 1, stays: "its conversation can't be opened on Account 2" }]);
    });

    it('CONTROL: without the fresh restart, Restart now moves nothing (it cannot carry the conversation)', async () => {
        const w = await stayingAfterSwitch();
        expect(w.host.moveNow('claude')).toBe(0);
        await flush();
        expect(w.drivers).toHaveLength(1);
    });

    it('the fresh restart starts it on the active account as a NEW conversation', async () => {
        const w = await stayingAfterSwitch();
        expect(w.host.moveNow('claude', undefined, { fresh: true })).toBe(1);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(2));
        expect(w.drivers[0]!.killed).toBe(true);
        expect(w.drivers[1]!.account?.id).toBe(B.id);
        expect(w.drivers[1]!.resume).toBeNull();
        await vi.waitFor(() => expect(w.host.probe(w.record.id)?.account).toEqual({ id: B.id, label: 'Account 2' }));
        expect(w.host.stillOn('claude')).toEqual([]);
    });
});
