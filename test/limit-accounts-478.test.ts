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
 * A HOLD BELONGS TO AN ACCOUNT (Tynn #478, Accounts S5), AND EVERY AGENT RUNS ON THE ACTIVE ONE (Tynn #751, Accounts R1).
 * Two Claude accounts are two logins, each with its own limit; the active account's limit holds every agent of the provider,
 * and a reading carries the account that was active when it arrived. Fixtures use no real person.
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
let activeId = ACCOUNT_A;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-limit-accounts-'));
    now = Date.UTC(2026, 10, 15, 3, 0, 0);
    timers = [];
    activeId = ACCOUNT_A;
    events.clear();
    sent.clear();
    readings.length = 0;
    host = new SessionHost({
        userData: dir, driverFor, clock: () => now, processTree: noTree,
        activeAccount: () => book.get(activeId) ?? null,
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

const record = (name: string): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name });
const meta = (status: string, resetsAtMs: number, utilization = 1) => ({
    sessionUpdate: 'notice', notice: { level: 'info', message: status === 'allowed' ? 'rate limit ok' : "You've hit your limit" },
    _meta: { 'particle.academy/rate_limit': { status, rateLimitType: 'five_hour', resetsAtMs, windows: { five_hour: { utilization, resetsAtMs } }, raw: {} } },
});
const rejected = (name: string, resetsAtMs: number) => events.get(name)!.onUpdate?.(meta('rejected', resetsAtMs));
const failTurn = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution' });
const hitLimit = (a: AgentRecord, resetsAtMs: number) => { host.prompt(a.id, 'build it', 'you'); rejected(a.name, resetsAtMs); failTurn(a.name); };

const switchTo = (id: string) => { activeId = id; };

describe('the active account’s hold holds every agent of the provider', () => {
    it('one limit on the active account: every agent waits, the probe says so', () => {
        const a1 = record('atlas'); const a2 = record('wren'); const a3 = record('kai');
        for (const r of [a1, a2, a3]) expect(host.start(r, dir)).toEqual({ ok: true });
        hitLimit(a1, now + 60 * MIN);
        for (const r of [a1, a2, a3]) expect(host.probe(r.id)?.limit).toMatchObject({ state: 'paused' });
        host.prompt(a2.id, 'hello', 'you');
        expect(sent.get('wren')).toEqual([]);
    });

    it('an agent STARTED after a switch to B is not held by A’s limit; one started on A again is', () => {
        const a1 = record('atlas');
        host.start(a1, dir);
        hitLimit(a1, now + 60 * MIN);
        switchTo(ACCOUNT_B);
        const onB = record('lateb');
        host.start(onB, dir);
        host.prompt(onB.id, 'hi', 'you');
        expect(sent.get('lateb')).toEqual(['hi']);
        switchTo(ACCOUNT_A);
        const onA = record('latea');
        host.start(onA, dir);
        host.prompt(onA.id, 'hi', 'you');
        expect(sent.get('latea')).toEqual([]);
    });

    it('the held logins name the active account, one login however many agents it holds', () => {
        const a1 = record('atlas'); const b1 = record('kai');
        host.start(a1, dir); host.start(b1, dir);
        hitLimit(a1, now + 60 * MIN);
        expect(host.heldLogins()).toMatchObject([{ provider: 'claude', account: ACCOUNT_A, view: { state: 'paused' } }]);
        expect(host.heldLogins()).toHaveLength(1);
    });

    it('both accounts limited: Resume now opens the ACTIVE account’s hold only, and A is still limited when it is made active again', () => {
        const a1 = record('atlas');
        host.start(a1, dir);
        hitLimit(a1, now + 60 * MIN);
        switchTo(ACCOUNT_B);
        const b1 = record('kai');
        host.start(b1, dir);
        hitLimit(b1, now + 90 * MIN);
        expect(host.probe(b1.id)?.limit).toMatchObject({ state: 'paused' });
        host.resumeLimit('claude');
        expect(host.probe(b1.id)?.limit).toEqual({ state: 'open' });
        switchTo(ACCOUNT_A);
        const again = record('again');
        host.start(again, dir);
        expect(host.probe(again.id)?.limit).toMatchObject({ state: 'paused' });
    });

    it('CONTROL: two agents on the SAME account share one hold', () => {
        const a1 = record('atlas'); const a2 = record('wren');
        host.start(a1, dir); host.start(a2, dir);
        hitLimit(a1, now + 60 * MIN);
        expect(host.probe(a2.id)?.limit).toMatchObject({ state: 'paused' });
        host.resumeLimit('claude');
        expect(host.probe(a1.id)?.limit).toEqual({ state: 'open' });
        expect(host.probe(a2.id)?.limit).toEqual({ state: 'open' });
    });
});

describe('a reading is stamped with the account that is ACTIVE when it arrives', () => {
    it('before and after a switch, the stamp follows the active account; each run keeps a run id of its own', () => {
        host.start(record('atlas'), dir);
        host.start(record('kai'), dir);
        events.get('atlas')!.onUpdate?.(meta('allowed', now + 60 * MIN, 0.4));
        switchTo(ACCOUNT_B);
        events.get('kai')!.onUpdate?.(meta('allowed', now + 60 * MIN, 0.5));
        const stamps = readings.map((r) => r.stamp);
        expect(stamps).toHaveLength(2);
        expect(stamps[0]).toMatchObject({ accountId: ACCOUNT_A });
        expect(stamps[1]).toMatchObject({ accountId: ACCOUNT_B });
        expect(stamps[0]!.runId).toMatch(/\S/);
        expect(stamps[1]!.runId).not.toBe(stamps[0]!.runId);
    });
});

describe('Resume now opens the provider’s ACTIVE account (Tynn #478, #751)', () => {
    it('a per-agent Resume now names the provider only', () => {
        const a1 = record('atlas');
        host.start(a1, dir);
        hitLimit(a1, now + 60 * MIN);
        host.resumeLimit(a1.provider);
        expect(host.probe(a1.id)?.limit).toEqual({ state: 'open' });
    });

    it('host-api passes the provider only; the client sends it and the server hands it to the host', () => {
        const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
        expect(read('src/main/host-api.ts')).toContain('deps.host.resumeLimit(r.provider);');
        expect(read('src/main/session-engine-client.ts')).toContain("this.call('engine.resumeLimit', accountId === undefined ? [provider] : [provider, accountId])");
        // A flow paused at a limit: Resume now lifts the provider's active account's hold (Tynn #749 + #751).
        expect(read('src/main/genie-host.ts')).toContain('host.resumeLimit(record.provider);');
        expect(read('src/main/session-engine-server.ts')).toContain("host.resumeLimit(str(0), typeof args[1] === 'string' ? args[1] : undefined);");
    });
});
