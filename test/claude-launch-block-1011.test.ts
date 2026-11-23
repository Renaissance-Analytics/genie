import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriver } from '../src/core/session.js';
import { claudeSignedInActive } from '../src/main/claude-sign-ins.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * WHAT A CLAUDE SIGN-IN HOLDS BACK, AND WHAT GOES WHEN IT IS OVER (Tynn #1011; the review of #2139, findings 1 and 4).
 * Nothing launches in a folder a sign-in is running in (prism-acp: one process per folder at a time). A start refused for
 * that says "it starts once the sign-in is over", so it does: when the sign-in ends, however it ends, the launches it refused
 * are started, and an agent that waited to move to that account is asked again. The owner's rule: an agent never sits waiting
 * on a person once the cause is gone. And the host can say how many runs are in an account's folder, so "Sign out and
 * remove" never takes a folder from under one. Fixtures name no person.
 */
const THREAD = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d';
const BLOCKED = 'That account is signing in; it starts once the sign-in is over.';
const acct = (suffix: string, configDir?: string): AccountRecord => ({
    id: `account_${suffix.repeat(32)}`, provider: 'claude', label: `Account ${suffix}`, labelEdited: false, home: '/home/.claude', legacy: false,
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-21T00:00:00Z', ...(configDir ? { configDir, method: 'subscription' as const } : {}),
});
const A = acct('1');
const B = acct('2', '/genie/accounts/claude/b');
const C = acct('3', '/genie/accounts/claude/c');

describe('SessionHost: a launch a sign-in refused, and who runs in an account\'s folder', () => {
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-1011-block-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    interface Driver { name: string; events: DriverEvents; account: AccountRecord | undefined; killed: boolean }
    function world(start: { active?: AccountRecord; signingIn?: string | null; graceMs?: number } = {}) {
        let active: AccountRecord = start.active ?? B;
        let signingIn: string | null = start.signingIn ?? null;
        const gone = new Set<string>();
        const drivers: Driver[] = [];
        let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
        const tree: ProcessTree = {
            snapshot: () => [...processes],
            killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
        };
        const records = new Map<string, AgentRecord>();
        const driverFor: DriverFor = (agent, _cwd, _resume, extras) => ({ events }) => {
            const pid = process.pid + 1_000_000 + drivers.length + 1;
            let running = false;
            const d: Driver = { name: agent.name, events, account: extras?.account, killed: false };
            drivers.push(d);
            const driver: SessionDriver = {
                start: () => { running = true; processes.push({ pid, ppid: process.pid, started: 3, name: 'claude-fixture' }); },
                prompt: () => {},
                cancel: () => Promise.resolve(),
                kill: () => { d.killed = true; running = false; processes = processes.filter((p) => p.pid !== pid); },
                get running() { return running; },
                get cliSessionId() { return THREAD; },
            };
            return driver;
        };
        const host = new SessionHost({
            userData: dir, driverFor, processTree: tree, stopGraceMs: start.graceMs ?? 0,
            activeAccount: () => active,
            launchBlocked: (account) => (account.configDir !== undefined && account.configDir === signingIn ? BLOCKED : null),
            currentRecord: (id) => (gone.has(id) ? null : records.get(id) ?? null),
            threadInAccount: () => 'present',
        });
        hosts.push(host);
        const agent = (name: string): AgentRecord => {
            const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name }), threadId: THREAD };
            records.set(record.id, record);
            return record;
        };
        return { host, drivers, agent, setActive: (a: AccountRecord) => { active = a; }, signIn: (configDir: string | null) => { signingIn = configDir; }, remove: (id: string) => { gone.add(id); } };
    }

    it('a start refused by a sign-in in its folder is started when the sign-in is over, and its refusal is gone', () => {
        const w = world({ signingIn: B.configDir! });
        const atlas = w.agent('atlas');
        expect(w.host.start(atlas, dir)).toEqual({ ok: false, reason: BLOCKED });
        expect(w.host.refusals.get(atlas.id)).toBe(BLOCKED);
        expect(w.drivers).toHaveLength(0);
        w.signIn(null);
        w.host.launchUnblocked();
        expect(w.drivers.map((d) => [d.name, d.account?.id])).toEqual([['atlas', B.id]]);
        expect(w.host.refusals.get(atlas.id)).toBeUndefined();
        expect(w.host.startedIds()).toEqual([atlas.id]);
    });

    it('CONTROL: nothing was refused by a sign-in, so its end starts nothing (an agent never started stays as it is)', () => {
        const w = world();
        w.agent('never-started');
        w.host.launchUnblocked();
        expect(w.drivers).toHaveLength(0);
    });

    it('while the folder is still signing in (another sign-in there) it stays refused, and the next end starts it', () => {
        const w = world({ signingIn: B.configDir! });
        const atlas = w.agent('atlas');
        w.host.start(atlas, dir);
        w.host.launchUnblocked();
        expect(w.drivers).toHaveLength(0);
        expect(w.host.refusals.get(atlas.id)).toBe(BLOCKED);
        w.signIn(null);
        w.host.launchUnblocked();
        expect(w.drivers).toHaveLength(1);
    });

    it('started once only: the person started it meanwhile, or the end is told twice', () => {
        const w = world({ signingIn: B.configDir! });
        const atlas = w.agent('atlas');
        w.host.start(atlas, dir);
        w.signIn(null);
        expect(w.host.start(atlas, dir)).toEqual({ ok: true });
        w.host.launchUnblocked();
        w.host.launchUnblocked();
        expect(w.drivers).toHaveLength(1);
    });

    it('an agent removed while it waited is not started', () => {
        const w = world({ signingIn: B.configDir! });
        const atlas = w.agent('atlas'), bolt = w.agent('bolt');
        w.host.start(atlas, dir);
        w.host.start(bolt, dir);
        w.remove(atlas.id);
        w.signIn(null);
        w.host.launchUnblocked();
        expect(w.drivers.map((d) => d.name)).toEqual(['bolt']);
        expect(w.host.refusals.get(atlas.id)).toBeUndefined();
    });

    it('an agent that waited to MOVE to the account that was signing in is asked again when the sign-in is over', async () => {
        const w = world({ active: A });
        const atlas = w.agent('atlas');
        expect(w.host.start(atlas, dir)).toEqual({ ok: true });
        w.signIn(B.configDir!);
        w.setActive(B);
        w.host.accountChanged('claude');
        await new Promise((r) => setTimeout(r, 50));
        // It stays where it is while B's folder signs in: still running, on A.
        expect(w.drivers).toHaveLength(1);
        expect(w.drivers[0]!.killed).toBe(false);
        w.signIn(null);
        w.host.launchUnblocked();
        await vi.waitFor(() => expect(w.drivers).toHaveLength(2));
        expect(w.drivers[1]!.account?.id).toBe(B.id);
    });

    it('runningIn: how many runs are in an account\'s folder; none in another folder, none once they have ended', async () => {
        const w = world();
        const atlas = w.agent('atlas'), bolt = w.agent('bolt');
        expect(w.host.runningIn(B.configDir!)).toBe(0);
        w.host.start(atlas, dir);
        w.host.start(bolt, dir);
        expect(w.host.runningIn(B.configDir!)).toBe(2);
        expect(w.host.runningIn(C.configDir!)).toBe(0);
        // THE CASE THE REVIEW NAMED: the person made another account active; the agents are still in B's folder.
        w.setActive(C);
        expect(w.host.runningIn(B.configDir!)).toBe(2);
        w.host.stop(atlas.id, { graceful: false });
        await w.host.ended(atlas.id);
        expect(w.host.runningIn(B.configDir!)).toBe(1);
        w.host.stop(bolt.id, { graceful: false });
        await w.host.ended(bolt.id);
        expect(w.host.runningIn(B.configDir!)).toBe(0);
    });

    it('runningIn counts a run that is still stopping: its process is in the folder until it has ended', async () => {
        const w = world({ graceMs: 300 });
        const atlas = w.agent('atlas');
        w.host.start(atlas, dir);
        w.host.stop(atlas.id);
        // No longer a live session, and not yet over.
        expect(w.host.startedIds()).toEqual([]);
        expect(w.drivers[0]!.killed).toBe(false);
        expect(w.host.runningIn(B.configDir!)).toBe(1);
        await w.host.ended(atlas.id);
        expect(w.host.runningIn(B.configDir!)).toBe(0);
    });

    it('signed in again on the active account: ONLY the agent it had signed out is started again, not one stopped by hand nor one at work', () => {
        const w = world();
        const out = w.agent('signed-out'), fine = w.agent('at-work'), stopped = w.agent('stopped-by-hand');
        for (const r of [out, fine, stopped]) w.host.start(r, dir);
        w.host.stop(stopped.id, { graceful: false });
        w.drivers.find((d) => d.name === 'signed-out')!.events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind: 'auth', reason: 'authentication_failed' } } as never);
        const restarted: string[] = [];
        claudeSignedInActive({
            attribution: () => {}, refreshHealth: () => {}, refreshLive: () => {},
            signedOutAgents: (p, id) => w.host.signedOutAgents(p, id), restart: (id) => { restarted.push(id); }, resumeLimit: (p, id) => { w.host.resumeLimit(p, id); },
        })('claude', B.id);
        expect(restarted).toEqual([out.id]);
        // A sign-in of an account that is NOT the active one signs nobody back in.
        claudeSignedInActive({
            attribution: () => {}, refreshHealth: () => {}, refreshLive: () => {},
            signedOutAgents: (p, id) => w.host.signedOutAgents(p, id), restart: (id) => { restarted.push(id); }, resumeLimit: () => {},
        })('claude', C.id);
        expect(restarted).toEqual([out.id]);
    });
});
