import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyAccountId, providerAccountEnv, type AccountRecord } from '../src/core/accounts.js';
import type { AcpProvider } from '../src/core/engine.js';
import type { Headroom, ReadingStamp } from '../src/core/headroom.js';
import { AGENT_RECORD_FIELDS, agentRecord, mintAgentId, withoutAgentAccount, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { AccountsHost, type AccountsOptions } from '../src/main/accounts-host.js';
import { providerLaunchOptions, SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * ACCOUNTS R1 (Tynn #751). The owner, 2026-11-16: "the logged in account is the active account on the host machine. All
 * agents use the logged in account, we just track the usage and have awareness of each account so users can easily switch
 * accounts to manage rate limit juggling." ONE active account per provider; every agent, probe and terminal uses it.
 * Fixtures use no real person.
 */
const MIN = 60_000;
const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const CODEX = `account_${'c'.repeat(32)}`;
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');

const managed = (provider: AcpProvider, id: string, suffix: string): AccountRecord => ({
    id, provider, legacy: false, labelEdited: false, label: `Account ${suffix}`, home: `/genie/accounts/${provider}/${suffix}`,
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-16T00:00:00Z',
});

/* ---- the account book: one active account per provider ---- */
describe('R1: the book holds ONE active account per provider', () => {
    let dir: string;
    let options: AccountsOptions;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-active-751-'));
        let n = 0;
        options = { root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'old-claude'), codex: join(dir, 'old-codex') },
            now: () => '2026-11-16T00:00:00.000Z', mintId: () => `account_${String(++n).padStart(32, '0')}`, provision: async () => {} };
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('CONTROL: with nothing chosen each provider is on its legacy account', async () => {
        const book = await AccountsHost.open(options);
        expect(book.activeFor('claude').id).toBe(legacyAccountId('claude'));
        expect(book.activeFor('codex').id).toBe(legacyAccountId('codex'));
    });

    it('setActive makes a managed account the provider’s active one, and only that provider’s', async () => {
        const book = await AccountsHost.open(options);
        const added = await book.add({ provider: 'claude' });
        await book.setActive('claude', added.id);
        expect(book.activeFor('claude').id).toBe(added.id);
        expect(book.activeFor('codex').id).toBe(legacyAccountId('codex'));
    });

    it('the active account is durable: a reopened book is on the same account', async () => {
        const book = await AccountsHost.open(options);
        const added = await book.add({ provider: 'claude' });
        await book.setActive('claude', added.id);
        const again = await AccountsHost.open(options);
        expect(again.activeFor('claude').id).toBe(added.id);
    });

    it('an unknown account is refused, and the active account does not move', async () => {
        const book = await AccountsHost.open(options);
        await expect(book.setActive('claude', `account_${'f'.repeat(32)}`)).rejects.toThrow(/account/i);
        expect(book.activeFor('claude').id).toBe(legacyAccountId('claude'));
    });

    it('another provider’s account is refused for this provider', async () => {
        const book = await AccountsHost.open(options);
        const other = await book.add({ provider: 'codex' });
        await expect(book.setActive('claude', other.id)).rejects.toThrow(/provider|account/i);
        expect(book.activeFor('claude').id).toBe(legacyAccountId('claude'));
    });
});

/* ---- every launch uses the active account ---- */
describe('R1: every agent launches on the provider’s active account', () => {
    const dirs: string[] = [];
    const hosts: SessionHost[] = [];
    afterEach(async () => {
        for (const host of hosts.splice(0)) host.stopAll();
        vi.unstubAllEnvs();
        for (const p of dirs.splice(0)) await rm(p, { recursive: true, force: true });
    });
    const noProcesses: ProcessTree = { snapshot: () => [], killTree: pids => ({ killed: pids.length, refused: false }) };
    const inert: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, cliSessionId: null });
    const injected = { CLAUDE_CONFIG_DIR: '/workspace/other-claude', CODEX_HOME: '/workspace/other-codex', DB_PORT: '4312' };

    async function fixture(active: Partial<Record<AcpProvider, AccountRecord | null>>, deferred = false) {
        const dir = await mkdtemp(join(tmpdir(), 'genie-launch-751-'));
        dirs.push(dir);
        const seen: Array<{ name: string; account: AccountRecord | undefined; env: Readonly<Record<string, string | undefined>> }> = [];
        const driverFor: DriverFor = (record, _cwd, _resume, extras) => {
            const bound = (extras as (typeof extras & { account?: AccountRecord }))?.account;
            const opts = providerLaunchOptions(undefined, extras?.serviceEnv ?? {}, { execPath: '/usr/bin/node', electron: false }, bound);
            seen.push({ name: record.name, account: bound, env: childEnv(opts.parentEnv ?? {}, { allow: opts.allowEnv ?? [] }).env });
            return inert;
        };
        const host = new SessionHost({ userData: dir, driverFor, processTree: noProcesses, serviceEnvFor: () => injected,
            activeAccount: provider => active[provider as AcpProvider] ?? null,
            ...(deferred ? { prepareMcpServers: async () => [] } : {}) } as ConstructorParameters<typeof SessionHost>[0]);
        hosts.push(host);
        return { dir, host, seen, active };
    }
    const agent = (name: string, provider: AcpProvider = 'claude'): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'fixture', provider, name });
    const variable = (provider: AcpProvider) => provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';

    it.each(['claude', 'codex'] as const)('%s: two agents both launch on the active account, whatever the agent was before', async provider => {
        const active = managed(provider, provider === 'claude' ? B : CODEX, 'b');
        const f = await fixture({ [provider]: active });
        expect(f.host.start(agent('atlas', provider), f.dir)).toEqual({ ok: true });
        expect(f.host.start(agent('wren', provider), f.dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(f.seen).toHaveLength(2));
        expect(f.seen.map(s => s.account)).toEqual([active, active]);
        for (const s of f.seen) expect(s.env[variable(provider)]).toBe(active.home);
    });

    it('a deferred launch (connections prepared first) uses the active account too', async () => {
        const active = managed('claude', B, 'b');
        const f = await fixture({ claude: active }, true);
        expect(f.host.start(agent('atlas'), f.dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(f.seen).toHaveLength(1));
        expect(f.seen[0]!.account).toEqual(active);
    });

    it('an agent started after the active account changed launches on the new one', async () => {
        const a = managed('claude', A, 'a'), b = managed('claude', B, 'b');
        const f = await fixture({ claude: a });
        expect(f.host.start(agent('first'), f.dir)).toEqual({ ok: true });
        f.active.claude = b;
        expect(f.host.start(agent('second'), f.dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(f.seen).toHaveLength(2));
        expect(f.seen.map(s => [s.name, s.account?.id])).toEqual([['first', A], ['second', B]]);
    });

    it('a provider with no active account is refused before a driver is built', async () => {
        const f = await fixture({ claude: null });
        expect(f.host.start(agent('atlas'), f.dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/account/i) });
        expect(f.seen).toEqual([]);
    });

    it.each(['claude', 'codex'] as const)('CONTROL: %s legacy active keeps the existing environment, home unset stays unset', async provider => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
        vi.stubEnv('CODEX_HOME', undefined);
        const legacy: AccountRecord = { ...managed(provider, legacyAccountId(provider), 'legacy'), legacy: true, home: `/profile/.${provider}` };
        const f = await fixture({ [provider]: legacy });
        expect(f.host.start(agent('atlas', provider), f.dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(f.seen).toHaveLength(1));
        expect(f.seen[0]!.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
        expect(f.seen[0]!.env).not.toHaveProperty('CODEX_HOME');
        expect(f.seen[0]!.env.DB_PORT).toBe('4312');
    });

    it.each(['claude', 'codex'] as const)('CONTROL: %s legacy account env is the parent env, exactly', provider => {
        const parent = Object.freeze({ PATH: '/bin', FIXTURE: 'kept' });
        expect(providerAccountEnv({ provider, home: `/profile/.${provider}`, legacy: true }, parent)).toEqual(parent);
    });
});

/* ---- the host's wiring: everything that runs a provider uses the active account ---- */
describe('R1: the host resolves the ACTIVE account for launches, probes, Take Over and sign-in', () => {
    it('the session host, model list, health, status and window account all read the active account', () => {
        const host = source('src/main/genie-host.ts');
        expect(host).toContain('activeAccount: provider => isAcpProvider(provider) ? accounts.activeFor(provider) : null');
        expect(host).toContain('providerAccount: provider => isAcpProvider(provider) ? accounts.activeFor(provider) : null');
        expect(host).toContain('realListModels(provider, accounts.activeFor(provider))');
        expect(host).toContain('checkProviderHealth(provider, realProviderHealthPorts(execFileRunner), accounts.activeFor(provider))');
        expect(host).not.toContain('accounts.defaultFor(');
    });
    it('Take Over opens the provider’s active account, not an agent’s', () => {
        expect(source('src/main/genie-host.ts')).toContain('accountFor: record => accounts.activeFor(record.provider)');
    });
    it('Resume now names the provider; the account is the active one, never an agent’s', () => {
        expect(source('src/main/host-api.ts')).toContain('deps.host.resumeLimit(r.provider);');
        expect(source('src/main/genie-host.ts')).toContain('host.resumeLimit(record.provider);');
    });
    it('the window’s sign-in names the provider, and signs in the active account', () => {
        expect(source('src/main/main.ts')).toContain('signIn!(record.provider)');
    });
});

/* ---- an agent carries no account ---- */
describe('R1: an agent record carries no account', () => {
    it('the record’s field list has no accountId', () => {
        expect([...AGENT_RECORD_FIELDS]).not.toContain('accountId');
    });
    it('a new agent record has no accountId', () => {
        expect('accountId' in agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'fixture' })).toBe(false);
    });
    it('a stored record is read without its accountId, its threads folded to the provider, nothing else changed', () => {
        const stored = { ...agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'fixture' }), accountId: A, threadId: 'thread-A', model: 'sonnet',
            threadIds: { 'codex:account_legacy_codex': 'codex-thread', [`claude:${A}`]: 'older-claude' },
            leftAt: { 'codex:account_legacy_codex': '2026-11-14T00:00:00Z' } } as unknown as AgentRecord;
        const read = withoutAgentAccount(stored) as unknown as Record<string, unknown>;
        expect('accountId' in read).toBe(false);
        expect(read).toMatchObject({ threadId: 'thread-A', model: 'sonnet', name: 'fixture',
            threadIds: { codex: 'codex-thread', claude: 'older-claude' }, leftAt: { codex: '2026-11-14T00:00:00Z' } });
    });
    it('CONTROL: provider-keyed slots are already the shape and stay as they are', () => {
        const stored = { ...agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'fixture' }), threadIds: { codex: 'c' }, leftAt: { codex: 't' } } as AgentRecord;
        expect(withoutAgentAccount(stored)).toMatchObject({ threadIds: { codex: 'c' }, leftAt: { codex: 't' } });
    });
});

/* ---- usage tracked per account; holds on the active account ---- */
describe('R1: readings stamp the active account; a hold is the active account’s', () => {
    let dir: string;
    let now = Date.UTC(2026, 10, 16, 3, 0, 0);
    let timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
    const events = new Map<string, DriverEvents>();
    const readings: Array<{ provider: string; room: Headroom; stamp: ReadingStamp | undefined }> = [];
    const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
    const book = new Map([[A, managed('claude', A, 'a')], [B, managed('claude', B, 'b')]]);
    let activeId = A;
    const driverFor: DriverFor = (record) => {
        const factory: SessionDriverFactory = (options) => {
            events.set(record.name, options.events);
            return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
        };
        return factory;
    };
    let host: SessionHost;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-limit-751-'));
        now = Date.UTC(2026, 10, 16, 3, 0, 0);
        timers = [];
        events.clear();
        readings.length = 0;
        activeId = A;
        host = new SessionHost({
            userData: dir, driverFor, clock: () => now, processTree: noTree,
            activeAccount: (provider) => provider === 'claude' ? book.get(activeId) ?? null : managed('codex', CODEX, 'c'),
            onHeadroom: (provider, room, stamp) => { readings.push({ provider, room, stamp }); },
            rateLimit: {
                gate: new RateLimitGate({ marginMs: 2 * MIN }),
                schedule: (ms, fn) => { const t = { at: now + ms, fn, cleared: false }; timers.push(t); return () => { t.cleared = true; }; },
            },
        } as ConstructorParameters<typeof SessionHost>[0]);
    });
    afterEach(async () => {
        host.stopAll();
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });
    const record = (name: string, provider: AcpProvider = 'claude'): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider, name });
    const meta = (status: string, resetsAtMs: number, utilization = 1) => ({
        sessionUpdate: 'notice', notice: { level: 'info', message: status === 'allowed' ? 'rate limit ok' : "You've hit your limit" },
        _meta: { 'particle.academy/rate_limit': { status, rateLimitType: 'five_hour', resetsAtMs, windows: { five_hour: { utilization, resetsAtMs } }, raw: {} } },
    });
    const hitLimit = (a: AgentRecord, resetsAtMs: number) => {
        host.prompt(a.id, 'build it', 'you');
        events.get(a.name)!.onUpdate?.(meta('rejected', resetsAtMs));
        events.get(a.name)!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution' });
    };

    it('a reading is stamped with the ACTIVE account, whichever agent heard it', () => {
        activeId = B;
        host.start(record('atlas'), dir);
        events.get('atlas')!.onUpdate?.(meta('allowed', now + 60 * MIN, 0.4));
        expect(readings.map((r) => r.stamp)).toMatchObject([{ accountId: B }]);
    });

    it('a reading after a switch is stamped with the new active account', () => {
        host.start(record('atlas'), dir);
        activeId = B;
        events.get('atlas')!.onUpdate?.(meta('allowed', now + 60 * MIN, 0.4));
        expect(readings.map((r) => r.stamp)).toMatchObject([{ accountId: B }]);
    });

    it('CONTROL: a limit on the active account holds every agent of the provider and no other provider', () => {
        const a1 = record('atlas'), a2 = record('wren'), other = record('kai', 'codex');
        for (const r of [a1, a2, other]) expect(host.start(r, dir)).toEqual({ ok: true });
        hitLimit(a1, now + 60 * MIN);
        expect(host.probe(a1.id)?.limit).toMatchObject({ state: 'paused' });
        expect(host.probe(a2.id)?.limit).toMatchObject({ state: 'paused' });
        expect(host.probe(other.id)?.limit).toEqual({ state: 'open' });
    });

    it('switching to an account with headroom lifts the hold; switching back to the limited account restores it', () => {
        const a1 = record('atlas'), a2 = record('wren');
        host.start(a1, dir); host.start(a2, dir);
        hitLimit(a1, now + 60 * MIN);
        expect(host.probe(a2.id)?.limit).toMatchObject({ state: 'paused' });
        activeId = B;
        const onB = record('kai');
        expect(host.start(onB, dir)).toEqual({ ok: true });
        expect(host.probe(onB.id)?.limit).toEqual({ state: 'open' });
        expect(host.heldLogins()).toEqual([]);
        activeId = A;
        const late = record('late');
        expect(host.start(late, dir)).toEqual({ ok: true });
        expect(host.probe(late.id)?.limit).toMatchObject({ state: 'paused' });
        expect(host.heldLogins()).toMatchObject([{ provider: 'claude', account: A, view: { state: 'paused' } }]);
    });

    it('CONTROL: Resume now with no account opens the active account’s hold for everyone on it', () => {
        const a1 = record('atlas'), a2 = record('wren');
        host.start(a1, dir); host.start(a2, dir);
        hitLimit(a1, now + 60 * MIN);
        host.resumeLimit('claude');
        expect(host.probe(a1.id)?.limit).toEqual({ state: 'open' });
        expect(host.probe(a2.id)?.limit).toEqual({ state: 'open' });
    });
});
