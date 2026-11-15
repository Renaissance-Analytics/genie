import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import type { Headroom, ReadingStamp } from '../src/core/headroom.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A HOLD BELONGS TO AN ACCOUNT (Tynn #478, Accounts S5). Two Claude accounts are two logins: a limit on A holds A's
 * agents and never B's, and a reading carries the account and run the agent was LAUNCHED on. Fixtures use no real person.
 */
const MIN = 60_000;
const ACCOUNT_A = `account_${'a'.repeat(32)}`;
const ACCOUNT_B = `account_${'b'.repeat(32)}`;
let dir: string;
let now = Date.UTC(2026, 10, 15, 3, 0, 0);
let timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
const events = new Map<string, DriverEvents>();
const sent = new Map<string, unknown[]>();
const readings: Array<{ provider: string; room: Headroom; stamp: ReadingStamp | undefined }> = [];
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

const accountRecord = (id: string, suffix: string): AccountRecord => ({
    id, provider: 'claude', legacy: false, labelEdited: false, label: `Account ${suffix}`, home: `/genie/accounts/claude/${suffix}`,
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-15T00:00:00Z',
});
const book = new Map([[ACCOUNT_A, accountRecord(ACCOUNT_A, 'a')], [ACCOUNT_B, accountRecord(ACCOUNT_B, 'b')]]);

const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        events.set(record.name, options.events);
        sent.set(record.name, []);
        return { start: () => {}, prompt: (t) => { sent.get(record.name)!.push(t); }, kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};

let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-limit-accounts-'));
    now = Date.UTC(2026, 10, 15, 3, 0, 0);
    timers = [];
    events.clear();
    sent.clear();
    readings.length = 0;
    host = new SessionHost({
        userData: dir, driverFor, clock: () => now, processTree: noTree,
        accountById: (id) => book.get(id) ?? null,
        onHeadroom: (provider, room, stamp) => { readings.push({ provider, room, stamp }); },
        rateLimit: {
            gate: new RateLimitGate({ marginMs: 2 * MIN }),
            schedule: (ms, fn) => { const t = { at: now + ms, fn, cleared: false }; timers.push(t); return () => { t.cleared = true; }; },
        },
    });
});
afterEach(async () => {
    host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (name: string, accountId: string): AgentRecord => ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name }), accountId });
const meta = (status: string, resetsAtMs: number, utilization = 1) => ({
    sessionUpdate: 'notice', notice: { level: 'info', message: status === 'allowed' ? 'rate limit ok' : "You've hit your limit" },
    _meta: { 'particle.academy/rate_limit': { status, rateLimitType: 'five_hour', resetsAtMs, windows: { five_hour: { utilization, resetsAtMs } }, raw: {} } },
});
const rejected = (name: string, resetsAtMs: number) => events.get(name)!.onUpdate?.(meta('rejected', resetsAtMs));
const failTurn = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution' });
const hitLimit = (a: AgentRecord, resetsAtMs: number) => { host.prompt(a.id, 'build it', 'you'); rejected(a.name, resetsAtMs); failTurn(a.name); };

describe('a hold on A does not hold B', () => {
    it('A’s agents are held; B’s agent on the same provider keeps working; the probe says so', () => {
        const a1 = record('atlas', ACCOUNT_A); const a2 = record('wren', ACCOUNT_A); const b1 = record('kai', ACCOUNT_B);
        for (const r of [a1, a2, b1]) expect(host.start(r, dir)).toEqual({ ok: true });
        hitLimit(a1, now + 60 * MIN);
        expect(host.probe(a1.id)?.limit).toMatchObject({ state: 'paused' });
        expect(host.probe(a2.id)?.limit).toMatchObject({ state: 'paused' });
        expect(host.probe(b1.id)?.limit).toEqual({ state: 'open' });
        host.prompt(a2.id, 'hello', 'you');
        expect(sent.get('wren')).toEqual([]);
        host.prompt(b1.id, 'go', 'you');
        expect(sent.get('kai')).toEqual(['go']);
    });

    it('an agent STARTED on B while A is held is not held; one started on A is', () => {
        const a1 = record('atlas', ACCOUNT_A);
        host.start(a1, dir);
        hitLimit(a1, now + 60 * MIN);
        const onB = record('lateb', ACCOUNT_B); const onA = record('latea', ACCOUNT_A);
        host.start(onB, dir); host.start(onA, dir);
        host.prompt(onB.id, 'hi', 'you'); host.prompt(onA.id, 'hi', 'you');
        expect(sent.get('lateb')).toEqual(['hi']);
        expect(sent.get('latea')).toEqual([]);
    });

    it('the held logins name the account, one per account', () => {
        const a1 = record('atlas', ACCOUNT_A); const b1 = record('kai', ACCOUNT_B);
        host.start(a1, dir); host.start(b1, dir);
        hitLimit(a1, now + 60 * MIN);
        expect(host.heldLogins()).toMatchObject([{ provider: 'claude', account: ACCOUNT_A, view: { state: 'paused' } }]);
        expect(host.heldLogins()).toHaveLength(1);
    });

    it('both held: Resume now on A releases A and leaves B held', () => {
        const a1 = record('atlas', ACCOUNT_A); const b1 = record('kai', ACCOUNT_B);
        host.start(a1, dir); host.start(b1, dir);
        hitLimit(a1, now + 60 * MIN);
        hitLimit(b1, now + 90 * MIN);
        expect(host.probe(a1.id)?.limit).toMatchObject({ state: 'paused' });
        expect(host.probe(b1.id)?.limit).toMatchObject({ state: 'paused' });
        host.resumeLimit('claude', ACCOUNT_A);
        expect(host.probe(a1.id)?.limit).toEqual({ state: 'open' });
        expect(host.probe(b1.id)?.limit).toMatchObject({ state: 'paused' });
    });

    it('CONTROL: two agents on the SAME account share one hold', () => {
        const a1 = record('atlas', ACCOUNT_A); const a2 = record('wren', ACCOUNT_A);
        host.start(a1, dir); host.start(a2, dir);
        hitLimit(a1, now + 60 * MIN);
        expect(host.probe(a2.id)?.limit).toMatchObject({ state: 'paused' });
        host.resumeLimit('claude', ACCOUNT_A);
        expect(host.probe(a1.id)?.limit).toEqual({ state: 'open' });
        expect(host.probe(a2.id)?.limit).toEqual({ state: 'open' });
    });
});

describe('a reading is stamped with the account and run the agent was launched on', () => {
    it('each launch stamps its own account and a run id of its own', () => {
        host.start(record('atlas', ACCOUNT_A), dir);
        host.start(record('kai', ACCOUNT_B), dir);
        events.get('atlas')!.onUpdate?.(meta('allowed', now + 60 * MIN, 0.4));
        events.get('kai')!.onUpdate?.(meta('allowed', now + 60 * MIN, 0.5));
        const stamps = readings.map((r) => r.stamp);
        expect(stamps).toHaveLength(2);
        expect(stamps[0]).toMatchObject({ accountId: ACCOUNT_A });
        expect(stamps[1]).toMatchObject({ accountId: ACCOUNT_B });
        expect(stamps[0]!.runId).toMatch(/\S/);
        expect(stamps[1]!.runId).not.toBe(stamps[0]!.runId);
    });
});

describe('a per-agent Resume now opens only that agent’s account (Tynn #478)', () => {
    it('resuming one agent on A leaves B held, and the account rides the engine protocol', () => {
        const a1 = record('atlas', ACCOUNT_A); const b1 = record('kai', ACCOUNT_B);
        host.start(a1, dir); host.start(b1, dir);
        hitLimit(a1, now + 60 * MIN);
        hitLimit(b1, now + 90 * MIN);
        // What host-api's resumeLimit does for an agent: its provider and ITS account.
        host.resumeLimit(a1.provider, a1.accountId);
        expect(host.probe(a1.id)?.limit).toEqual({ state: 'open' });
        expect(host.probe(b1.id)?.limit).toMatchObject({ state: 'paused' });
        host.resumeLimit(b1.provider, b1.accountId);
        expect(host.probe(b1.id)?.limit).toEqual({ state: 'open' });
    });

    it('host-api passes the agent’s account; the client sends it and the server hands it to the host', () => {
        const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
        expect(read('src/main/host-api.ts')).toContain('deps.host.resumeLimit(r.provider, r.accountId);');
        expect(read('src/main/session-engine-client.ts')).toContain("this.call('engine.resumeLimit', accountId === undefined ? [provider] : [provider, accountId])");
        // A flow paused at a limit: Resume now lifts the paused agent's own account (Tynn #749 + #478).
        expect(read('src/main/genie-host.ts')).toContain('host.resumeLimit(record.provider, record.accountId);');
        expect(read('src/main/session-engine-server.ts')).toContain("host.resumeLimit(str(0), typeof args[1] === 'string' ? args[1] : undefined);");
    });
});
