import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import * as Login from '../src/core/provider-login.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/*
 * TYNN #699, the account half (the coordinator, 2026-11-11). The owner hit Claude's limit and switched accounts; the agent
 * never resumed. A limit belongs to the ACCOUNT: once the provider's signed-in account changes — a Log in through Genie, or
 * Genie noticing a different account on its next status read — every agent held on that provider's limit is released and
 * its queue goes, as when the limit resets.
 */
const MIN = 60_000;
let dir: string;
let now = Date.UTC(2026, 10, 11, 18, 0, 0);
let timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
const events = new Map<string, DriverEvents>();
const sent = new Map<string, unknown[]>();
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
/** The account `claude auth status` reports now; `null` = no identity read (signed out, or nothing to tell by). */
let account: string | null = 'a@example.com';
let accountReads = 0;

const claudeRejected = (name: string) => events.get(name)!.onUpdate?.({
    sessionUpdate: 'notice', notice: { level: 'info', message: 'You have hit your limit' },
    _meta: { 'particle.academy/rate_limit': { status: 'rejected', rateLimitType: 'five_hour', resetsAtMs: now + 4 * 60 * MIN, windows: { five_hour: { utilization: 1, resetsAtMs: now + 4 * 60 * MIN } }, raw: {} } },
});

const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        events.set(record.name, options.events);
        sent.set(record.name, []);
        return { start: () => {}, prompt: (t) => { sent.get(record.name)!.push(t); }, kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};

let host: SessionHost;
const makeHost = (withAccount = true) => {
    host = new SessionHost({
        userData: dir, driverFor, clock: () => now, processTree: noTree,
        rateLimit: {
            gate: new RateLimitGate({ marginMs: 2 * MIN }),
            schedule: (ms: number, fn: () => void) => { const t = { at: now + Math.max(0, ms), fn, cleared: false }; timers.push(t); return () => { t.cleared = true; }; },
            ...(withAccount ? { accountOf: async (provider: string) => { accountReads += 1; return provider === 'claude' ? account : null; } } : {}),
        } as never,
    });
};
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-account-699-'));
    now = Date.UTC(2026, 10, 11, 18, 0, 0);
    timers = [];
    events.clear();
    sent.clear();
    account = 'a@example.com';
    accountReads = 0;
});
afterEach(async () => {
    host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const advanceTo = (t: number): void => {
    for (let ran = 0; ran < 200;) {
        const next = timers.filter((x) => !x.cleared && x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = Math.max(now, next.at);
        next.cleared = true;
        next.fn();
        ran += 1;
    }
    now = t;
};
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const claude = (name: string): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name });

async function heldOnTheLimit(name = 'moic'): Promise<AgentRecord> {
    const a = claude(name);
    host.start(a, dir);
    claudeRejected(name);
    await flush();
    host.prompt(a.id, 'are you there?', 'you');
    expect(host.probe(a.id)?.limit).toMatchObject({ state: 'paused' });
    expect(sent.get(name)).toEqual([]);
    return a;
}

describe('the signed-in account, as the status command reports it', () => {
    const identity = (Login as unknown as { accountIdentityFrom?: (stdout: string) => string | null }).accountIdentityFrom;
    it('is read from the JSON the status prints: two accounts read differently, the same account the same', () => {
        expect(identity, 'accountIdentityFrom').toBeTypeOf('function');
        const a = identity!(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@example.com', orgId: 'o1', subscriptionType: 'max' }));
        const again = identity!(JSON.stringify({ subscriptionType: 'max', orgId: 'o1', email: 'a@example.com', loggedIn: true, authMethod: 'claude.ai' }));
        const b = identity!(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'b@example.com', orgId: 'o2', subscriptionType: 'max' }));
        expect(a).not.toBeNull();
        expect(again).toBe(a);
        expect(b).not.toBe(a);
    });
    it('nothing to tell an account by — text, or JSON with no account in it — is no identity (CONTROL)', () => {
        expect(identity!('Logged in using ChatGPT')).toBeNull();
        expect(identity!(JSON.stringify({ loggedIn: false }))).toBeNull();
        expect(identity!('')).toBeNull();
    });
});

describe('a held login whose account changes', () => {
    it('noticed on the next status read: every agent held on it is released and its queue goes', async () => {
        makeHost();
        const a = await heldOnTheLimit('moic');
        const b = await heldOnTheLimit('tynn');
        await flush();
        account = 'b@example.com';
        advanceTo(now + 15 * MIN);
        await flush();
        expect(host.probe(a.id)?.limit).toEqual({ state: 'open' });
        expect(sent.get('moic')).toEqual(['are you there?']);
        expect(sent.get('tynn')).toEqual(['are you there?']);
        expect(host.probe(b.id)?.limit).toEqual({ state: 'open' });
    });

    it('CONTROL: the same account read again leaves the hold as it is', async () => {
        makeHost();
        const a = await heldOnTheLimit();
        advanceTo(now + 15 * MIN);
        await flush();
        expect(accountReads).toBeGreaterThanOrEqual(2);
        expect(host.probe(a.id)?.limit).toMatchObject({ state: 'paused' });
        expect(sent.get('moic')).toEqual([]);
    });

    it('CONTROL: a read with no identity (signed out, or nothing to tell by) changes nothing', async () => {
        makeHost();
        const a = await heldOnTheLimit();
        account = null;
        advanceTo(now + 15 * MIN);
        await flush();
        expect(host.probe(a.id)?.limit).toMatchObject({ state: 'paused' });
        expect(sent.get('moic')).toEqual([]);
    });

    it('CONTROL: an open login is never asked for its account', async () => {
        makeHost();
        const a = claude('moic');
        host.start(a, dir);
        advanceTo(now + 60 * MIN);
        await flush();
        expect(accountReads).toBe(0);
    });
});

describe('a Log in through Genie', () => {
    it('releases the agents held on that provider, as a reset does, and brings back the ones it signed out', async () => {
        const mod = await import('../src/main/login-host.js') as unknown as { afterSignedIn?: (provider: string, deps: { signedOutAgents: (p: string) => string[]; restart: (id: string) => void; resumeLimit: (p: string) => void }) => void };
        expect(mod.afterSignedIn, 'afterSignedIn').toBeTypeOf('function');
        const resumed: string[] = [];
        const restarted: string[] = [];
        mod.afterSignedIn!('claude', { signedOutAgents: () => ['x1'], restart: (id) => restarted.push(id), resumeLimit: (p) => resumed.push(p) });
        expect(resumed).toEqual(['claude']);
        expect(restarted).toEqual(['x1']);
    });

    it('end to end on the host: resumeLimit after a login sends what waited', async () => {
        makeHost(false);
        const a = await heldOnTheLimit();
        host.resumeLimit('claude');
        expect(host.probe(a.id)?.limit).toEqual({ state: 'open' });
        expect(sent.get('moic')).toEqual(['are you there?']);
    });
});
