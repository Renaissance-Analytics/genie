import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriver } from '../src/core/session.js';
import { promptDeliveries } from '../src/core/prompt-delivery.js';
import { openDurableStore, readPromptRows } from '../src/core/thread-store.js';
import { sessionsDir } from '../src/main/paths.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A WEEKLY LIMIT, A HELD AGENT, A MESSAGE (Tynn #1089; the owner, 2026-11-27, beta.66.1). His coordinator's turn ended on
 * "You've hit your weekly limit" on a spent account while another account was active and had room. It was held (the ledger
 * says "Paused"), but it did not move for 52 minutes: the move waited on a background shell of Claude's, and that shell
 * ending was never a reason to ask again. His message then moved it — and the old run left that message `undelivered`, so
 * the chat said "Not delivered. Kept for you to send again." while the message waited in the new run's queue; it went 8.5
 * minutes later. "Send all now" sent nothing: the host refused the queued message as "already queued", and that refusal was
 * drawn under the message, far from the button.
 *
 * Fixtures name no person.
 */

const THREAD = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d';
const acct = (suffix: string, configDir: string): AccountRecord => ({
    id: `account_${suffix.repeat(32)}`, provider: 'claude', label: `Account ${suffix}`, labelEdited: false, home: '/home/.claude', legacy: false,
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-21T00:00:00Z', configDir, method: 'subscription',
});
const A = acct('1', '/genie/accounts/claude/a');
const B = acct('2', '/genie/accounts/claude/b');
const MIN = 60_000;

/** Claude's rate_limit_event for a SPENT WEEK, as prism-acp carries it. */
const weekSpent = (now: number) => ({
    sessionUpdate: 'notice', notice: { level: 'warning', message: 'Rate limit: seven_day window at 100% used' },
    _meta: { 'particle.academy/rate_limit': { status: 'rejected', rateLimitType: 'seven_day', resetsAtMs: now + 6 * 24 * 60 * MIN, windows: { seven_day: { utilization: 1, resetsAtMs: now + 6 * 24 * 60 * MIN } }, raw: {} } },
});
const task = (payload: Record<string, unknown>) => ({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'task' }, _meta: { 'particle.academy/task': payload } });
const shellStarted = task({ event: 'started', taskId: 'b1', toolUseId: 'tu1', taskType: 'local_bash', description: 'Wait for the two shot runs', ambient: false });
const shellEnded = task({ event: 'ended', taskId: 'b1', toolUseId: 'tu1', taskType: null, description: null, ambient: false, status: 'completed', summary: 'done' });
/** The turn the weekly limit ended: Claude's assistant `error: "rate_limit"`, as prism-acp reports it. */
const endOnLimit = { stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind: 'rate_limit', reason: 'rate_limit' } };

interface Driver { prompts: unknown[]; events: DriverEvents; account: AccountRecord | undefined; killed: boolean }

describe('an agent held on a spent week while another account is active', () => {
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-1089-hold-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    function world(onStart?: (n: number) => void) {
        let active: AccountRecord = A;
        const drivers: Driver[] = [];
        let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
        const tree: ProcessTree = {
            snapshot: () => [...processes],
            killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
        };
        const driverFor: DriverFor = (_agent, _cwd, _resume, extras) => ({ events }) => {
            const pid = process.pid + 4_000_000 + drivers.length + 1;
            let running = false;
            const d: Driver = { prompts: [], events, account: extras?.account, killed: false };
            drivers.push(d);
            const driver: SessionDriver = {
                start: () => { running = true; processes.push({ pid, ppid: process.pid, started: 3, name: 'claude-fixture' }); onStart?.(drivers.length); },
                prompt: (content) => { d.prompts.push(content); },
                cancel: () => Promise.resolve(),
                kill: () => { d.killed = true; running = false; processes = processes.filter((p) => p.pid !== pid); },
                get running() { return running; },
                get cliSessionId() { return THREAD; },
            };
            return driver;
        };
        // ONE store, read back below: every run's rows, never only the current run's (`ledgerFor`), which would hide the old run's.
        const store = openDurableStore(sessionsDir(dir));
        const host = new SessionHost({ userData: dir, driverFor, processTree: tree, stopGraceMs: 0, activeAccount: () => active, threadInAccount: () => 'present', store: () => store });
        hosts.push(host);
        const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'atlas' }), threadId: THREAD };
        const switchTo = (a: AccountRecord) => { active = a; host.accountChanged('claude'); host.accountSwitched('claude', { account: a, headroom: null }); };
        /** Every delivery status the STORED record holds for one message, in order, across every run. */
        const statuses = async (promptId: string): Promise<string[]> => {
            await host.settled();
            const { rows } = await readPromptRows(store, record.id);
            return rows.flatMap(({ event: e }) => (e.kind === 'prompt_delivery' && e.id === promptId ? [e.status] : []));
        };
        /** What the record says of it now (`queued` before any delivery row). */
        const state = async (promptId: string): Promise<string | undefined> => {
            await host.settled();
            return promptDeliveries((await readPromptRows(store, record.id)).rows).get(promptId);
        };
        const messageId = async (text: string): Promise<string | undefined> => {
            await host.settled();
            const { rows } = await readPromptRows(store, record.id);
            return rows.flatMap(({ event: e }) => (e.kind === 'message' && e.text === text && e.pending ? [e.pending.id] : []))[0];
        };
        return { host, record, drivers, switchTo, statuses, state, messageId };
    }

    const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };

    /** On A, working, a background shell of Claude's running; the person switches to B; the week runs out mid-turn. */
    async function heldWithShell() {
        const w = world();
        expect(w.host.start(w.record, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        w.host.prompt(w.record.id, 'work', 'you');
        w.drivers[0]!.events.onUpdate?.(shellStarted);
        w.switchTo(B);
        await flush();
        w.drivers[0]!.events.onUpdate?.(weekSpent(Date.now()));
        w.drivers[0]!.events.onTurnEnd?.(endOnLimit);
        await flush();
        return w;
    }

    it('CONTROL: a weekly refusal holds the agent as a 5 h one does', async () => {
        const w = await heldWithShell();
        expect(w.host.probe(w.record.id)?.limit).toMatchObject({ state: 'paused' });
    });

    it('CONTROL: while Claude\'s background shell still runs, it waits (moving would kill the shell)', async () => {
        const w = await heldWithShell();
        expect(w.drivers).toHaveLength(1);
        expect(w.drivers[0]!.killed).toBe(false);
    });

    it('moves to the active account as soon as that shell ends, with nobody sending anything', async () => {
        const w = await heldWithShell();
        w.drivers[0]!.events.onUpdate?.(shellEnded);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(2), { timeout: 2_000 });
        expect(w.drivers[0]!.killed).toBe(true);
        expect(w.drivers[1]!.account?.id).toBe(B.id);
    });

    it('a message sent while it is held is never recorded "undelivered" across the move, and is sent by the new run', async () => {
        const w = world();
        w.host.start(w.record, dir);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        w.host.prompt(w.record.id, 'work', 'you');
        w.drivers[0]!.events.onUpdate?.(weekSpent(Date.now()));
        w.drivers[0]!.events.onTurnEnd?.(endOnLimit);
        await flush();
        w.host.prompt(w.record.id, 'why do I keep getting this?', 'you');
        await flush();
        const id = await w.messageId('why do I keep getting this?');
        expect(id).toBeDefined();
        w.switchTo(B);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(2));
        await vi.waitFor(() => expect(w.drivers[1]!.prompts.map((p) => JSON.stringify(p)).join('\n')).toContain('why do I keep getting this?'));
        await vi.waitFor(async () => expect((await w.statuses(id!)).at(-1)).toBe('sent'));
        // POSITIVE CONTROL of the reader: it sees this message's rows from the store, across both runs.
        expect((await w.statuses(id!)).length).toBeGreaterThan(0);
        expect(await w.statuses(id!)).not.toContain('undelivered');
    });

    it('a message the new run holds behind its turn is recorded as WAITING, not "undelivered"', async () => {
        // The new run is busy BEFORE what is owed reaches it (the owner's: an inbox notice's turn came first): a prompt handed to
        // it the moment it starts, ahead of the host's read of what it owes.
        let busy: (() => void) | null = null;
        const w = world((n) => { if (n === 2) queueMicrotask(() => busy?.()); });
        busy = () => { w.host.prompt(w.record.id, 'AgentInbox delivery: 1 message', 'genie'); };
        w.host.start(w.record, dir);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        w.host.prompt(w.record.id, 'work', 'you');
        w.drivers[0]!.events.onUpdate?.(weekSpent(Date.now()));
        w.drivers[0]!.events.onTurnEnd?.(endOnLimit);
        await flush();
        w.host.prompt(w.record.id, 'still there?', 'you');
        await flush();
        const id = (await w.messageId('still there?'))!;
        w.switchTo(B);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(2));
        await flush();
        // POSITIVE CONTROL of the setup: the new run took the notice first, so the owed message waits behind its turn.
        const sentToNewRun = (): string => w.drivers[1]!.prompts.map((p) => JSON.stringify(p)).join(' | ');
        expect(sentToNewRun()).toContain('AgentInbox delivery');
        expect(sentToNewRun()).not.toContain('still there?');
        // Waiting: what the chat draws as queued (`queued`, or `carried` across the move) — never "undelivered".
        expect(['queued', 'carried']).toContain(await w.state(id));
        expect(await w.statuses(id)).not.toContain('undelivered');
        // CONTROL: its turn ends, and it goes.
        w.drivers[1]!.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        await vi.waitFor(async () => expect((await w.statuses(id)).at(-1)).toBe('sent'));
    });

    it('"Send all now" on a message already waiting in the run answers that it is waiting — not a refusal', async () => {
        const w = world();
        w.host.start(w.record, dir);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(1));
        w.host.prompt(w.record.id, 'work', 'you');
        // Held on the limit (nothing switched): what the person sends waits in the run's queue.
        w.drivers[0]!.events.onUpdate?.(weekSpent(Date.now()));
        w.drivers[0]!.events.onTurnEnd?.(endOnLimit);
        await flush();
        w.host.prompt(w.record.id, 'next one', 'you');
        await flush();
        const id = (await w.messageId('next one'))!;
        expect(w.host.hasQueuedPrompt(w.record.id, id)).toBe(true);
        await expect(w.host.resolvePrompt(w.record.id, id, 'send')).resolves.toEqual({ ok: true, waiting: true });
    });
});

describe('a message a restart hands to a run that cannot send it yet', () => {
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-1089-restart-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    it('is recorded WAITING in the new run (the owner\'s "Not delivered. Kept for you to send again." while it waited), then sent', async () => {
        const drivers: Driver[] = [];
        let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
        const tree: ProcessTree = { snapshot: () => [...processes], killTree: (t) => { const ids = new Set(t.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: t.length, refused: false }; } };
        const driverFor: DriverFor = (_a, _c, _r, extras) => ({ events }) => {
            const pid = process.pid + 5_000_000 + drivers.length + 1;
            let running = false;
            const d: Driver = { prompts: [], events, account: extras?.account, killed: false };
            drivers.push(d);
            return { start: () => { running = true; processes.push({ pid, ppid: process.pid, started: 3, name: 'claude-fixture' }); }, prompt: (c) => { d.prompts.push(c); }, cancel: () => Promise.resolve(), kill: () => { d.killed = true; running = false; processes = processes.filter((p) => p.pid !== pid); }, get running() { return running; }, get cliSessionId() { return THREAD; } } as SessionDriver;
        };
        const store = openDurableStore(sessionsDir(dir));
        const host = new SessionHost({ userData: dir, driverFor, processTree: tree, stopGraceMs: 0, activeAccount: () => A, threadInAccount: () => 'present', store: () => store });
        hosts.push(host);
        const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'atlas' }), threadId: THREAD };
        const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };
        const state = async (id: string) => { await host.settled(); return promptDeliveries((await readPromptRows(store, record.id)).rows).get(id); };
        host.start(record, dir);
        await vi.waitFor(() => expect(drivers).toHaveLength(1));
        host.prompt(record.id, 'work', 'you');
        drivers[0]!.events.onUpdate?.(weekSpent(Date.now()));
        drivers[0]!.events.onTurnEnd?.(endOnLimit);
        await flush();
        host.prompt(record.id, 'first kept', 'you');
        await flush();
        await host.settled();
        const id = (await readPromptRows(store, record.id)).rows.flatMap(({ event: e }) => (e.kind === 'message' && e.text === 'first kept' && e.pending ? [e.pending.id] : []))[0]!;
        // The person stops it: what waited is kept "undelivered" (theirs to send again).
        host.stop(record.id, { graceful: false });
        await host.ended(record.id);
        expect(await state(id)).toBe('undelivered');
        // Started again (the one Restart, or Send all's), still held on the limit: what is owed is handed to the new run, and waits.
        expect(host.start(record, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(drivers).toHaveLength(2));
        await host.deliverOwed(record.id);
        expect(host.probe(record.id)?.limit).toMatchObject({ state: 'paused' });
        expect(drivers[1]!.prompts.map((p) => JSON.stringify(p)).join(' | ')).not.toContain('first kept');
        expect(await state(id)).toBe('carried');
    });
});

describe('the host says when an agent is held on the limit, or let go', () => {
    it('a refusal WITH a reading holds the agent and says so once — after the gate has it (the active-out rule looks then)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie-1089-held-'));
        const held: string[] = [];
        let gateSaidSpent: boolean | null = null;
        let running = false;
        const events: { e: DriverEvents | null } = { e: null };
        const driverFor: DriverFor = () => ({ events: ev }) => { events.e = ev; return { start: () => { running = true; }, prompt: () => {}, cancel: () => Promise.resolve(), kill: () => { running = false; }, get running() { return running; }, get cliSessionId() { return THREAD; } } as SessionDriver; };
        const tree: ProcessTree = { snapshot: () => [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }], killTree: () => ({ killed: 0, refused: false }) };
        const host: SessionHost = new SessionHost({ userData: dir, driverFor, processTree: tree, stopGraceMs: 0, activeAccount: () => A, threadInAccount: () => 'present',
            onHeldChanged: (provider: string) => { held.push(provider); gateSaidSpent = host.refusedUntil('claude', A.id) !== null; } });
        try {
            const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'atlas' }), threadId: THREAD };
            host.start(record, dir);
            await vi.waitFor(() => expect(events.e).not.toBeNull());
            host.prompt(record.id, 'work', 'you');
            events.e!.onUpdate?.(weekSpent(Date.now()));
            events.e!.onTurnEnd?.(endOnLimit);
            await vi.waitFor(() => expect(held).toEqual(['claude']));
            expect(gateSaidSpent).toBe(true);
        } finally {
            host.stopAll(); await host.drained(0); await host.settled();
            await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
        }
    });
});

describe('what a stopped run wrote last reaches the window', () => {
    it('the ledger read the moment the run stopped is read again once its last rows are written (the kept messages read "Not delivered", with Send all now)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie-1089-stale-'));
        let running = false;
        const events: { e: DriverEvents | null } = { e: null };
        const driverFor: DriverFor = () => ({ events: ev }) => { events.e = ev; return { start: () => { running = true; }, prompt: () => {}, cancel: () => Promise.resolve(), kill: () => { running = false; }, get running() { return running; }, get cliSessionId() { return THREAD; } } as SessionDriver; };
        const tree: ProcessTree = { snapshot: () => [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }], killTree: () => ({ killed: 0, refused: false }) };
        const store = openDurableStore(sessionsDir(dir));
        const host = new SessionHost({ userData: dir, driverFor, processTree: tree, stopGraceMs: 0, activeAccount: () => A, threadInAccount: () => 'present', store: () => store });
        try {
            const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'atlas' }), threadId: THREAD };
            host.start(record, dir);
            await vi.waitFor(() => expect(events.e).not.toBeNull());
            host.prompt(record.id, 'work', 'you');
            events.e!.onUpdate?.(weekSpent(Date.now()));
            events.e!.onTurnEnd?.(endOnLimit);
            await new Promise((r) => setTimeout(r, 0));
            host.prompt(record.id, 'first kept', 'you');
            await host.settled();
            host.stop(record.id, { graceful: false });
            // The window asks at once (as it does on the change the stop announces): the history is read now.
            host.ledgerFor(record.id);
            await host.ended(record.id);
            await host.settled();
            const status = () => {
                const rows = host.ledgerFor(record.id);
                const id = rows.flatMap(({ event: e }) => (e.kind === 'message' && e.text === 'first kept' && e.pending ? [e.pending.id] : []))[0];
                return id === undefined ? 'no message' : promptDeliveries(rows).get(id);
            };
            await vi.waitFor(() => expect(status()).toBe('undelivered'), { timeout: 3_000 });
        } finally {
            host.stopAll(); await host.drained(0); await host.settled();
            await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
        }
    });
});
