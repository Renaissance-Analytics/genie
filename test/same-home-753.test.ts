import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import type { AcpProvider } from '../src/core/engine.js';
import type { Headroom, ReadingStamp } from '../src/core/headroom.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { AccountIdentityReader, readAccountIdentity } from '../src/main/account-identity.js';
import { AccountsHost, type AccountsOptions } from '../src/main/accounts-host.js';
import { LoginHost } from '../src/main/login-host.js';
import { checkProviderHealth, type ProviderHealthPorts } from '../src/main/provider-health.js';
import { providerLaunchOptions, SessionHost, type DriverFor } from '../src/main/session-host.js';
import { TakeOverHost } from '../src/main/take-over-host.js';

/**
 * ACCOUNTS R2 (Tynn #753): ONE HOME PER PROVIDER. The owner, 2026-11-16: "I have been manually switching accounts so far and
 * agents keep going. that should not have changed." He re-signs in with the provider's own login in the normal home
 * (~/.claude, ~/.codex); his agents keep their threads because their session files live in that one home. R1 gave managed
 * accounts their own CLAUDE_CONFIG_DIR / CODEX_HOME, which splits the session files. A launch, a probe, a Take Over and a
 * sign-in use the provider's normal environment exactly; Genie reads WHO is signed in and records it. Fixtures use no real person.
 */
const X = 'first@example.test';
const Y = 'second@example.test';
const identity = (email: string | null) => ({ name: null, email, plan: null });
const variable = (provider: AcpProvider) => provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
const managed = (provider: AcpProvider): AccountRecord => ({
    id: `account_${'b'.repeat(32)}`, provider, legacy: false, labelEdited: false, label: 'Account 2', home: `/genie/accounts/${provider}/b`,
    identity: identity(null), createdAt: '2026-11-16T00:00:00Z',
});
const legacy = (provider: AcpProvider): AccountRecord => ({ ...managed(provider), id: `account_legacy_${provider}`, legacy: true, home: `/profile/.${provider}` });

describe('R2: a launch uses the provider’s normal home environment', () => {
    beforeEach(() => { vi.stubEnv('CLAUDE_CONFIG_DIR', undefined); vi.stubEnv('CODEX_HOME', undefined); });
    afterEach(() => { vi.unstubAllEnvs(); });
    const childOf = (opts: ReturnType<typeof providerLaunchOptions>) => childEnv(opts.parentEnv ?? {}, { allow: opts.allowEnv ?? [] }).env;

    it.each(['claude', 'codex'] as const)('%s: a launch bound to a known account injects no home variable', provider => {
        const env = childOf(providerLaunchOptions(undefined, { DB_PORT: '4312' }, { execPath: '/usr/bin/node', electron: false }, managed(provider)));
        expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
        expect(env).not.toHaveProperty('CODEX_HOME');
        expect(env.DB_PORT).toBe('4312');
    });

    it.each(['claude', 'codex'] as const)('CONTROL: %s legacy launch keeps an unset home unset', provider => {
        const env = childOf(providerLaunchOptions(undefined, { DB_PORT: '4312' }, { execPath: '/usr/bin/node', electron: false }, legacy(provider)));
        expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
        expect(env).not.toHaveProperty('CODEX_HOME');
        expect(env.DB_PORT).toBe('4312');
    });
});

describe('R2: probes, Take Over and sign-in use the normal home too', () => {
    const elf = new Uint8Array(64); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); elf[18] = 0x3e;
    const portsFor = (provider: AcpProvider, envs: Array<Readonly<Record<string, string>> | undefined>): ProviderHealthPorts => ({
        platform: 'linux', arch: 'x64', env: { PATH: '/bin' }, isFile: p => p === `/bin/${provider}`, readText: () => '', readHead: () => elf,
        realpath: p => p, chosen: () => null, now: () => 1,
        run: async (_binary, _args, options) => { envs.push((options as { env?: Readonly<Record<string, string>> } | undefined)?.env); return { exitCode: 0, stdout: '{}' }; },
    });

    it.each(['claude', 'codex'] as const)('%s: the health probes carry no home variable for a known account', async provider => {
        const envs: Array<Readonly<Record<string, string>> | undefined> = [];
        await checkProviderHealth(provider, portsFor(provider, envs), managed(provider));
        expect(envs.length).toBeGreaterThan(0);
        for (const env of envs) expect(env?.[variable(provider)]).toBeUndefined();
    });

    it.each(['claude', 'codex'] as const)('%s: the identity read carries no home variable for a known account', async provider => {
        const envs: Array<Readonly<Record<string, string>> | undefined> = [];
        await readAccountIdentity(managed(provider), portsFor(provider, envs));
        expect(envs).toHaveLength(1);
        expect(envs[0]?.[variable(provider)]).toBeUndefined();
    });

    it.each(['claude', 'codex'] as const)('%s: Take Over opens with no home variable beside its own MCP attribution', provider => {
        const opened: Array<{ env?: Readonly<Record<string, string>> | undefined }> = [];
        const record = agentRecord({ id: mintAgentId(), name: 'fixture', provider, workspaceId: 'fixture' });
        const host = new TakeOverHost({ accountFor: () => managed(provider),
            terminals: { open: (options: (typeof opened)[number]) => { opened.push(options); return { id: 'fixture-terminal' }; },
                close: () => true, onData: () => () => {}, onExit: () => () => {} } as never,
            openWindow: () => {}, mcp: () => ({ mcpUrl: 'http://127.0.0.1:9/mcp', token: 'fixture-bearer' }) });
        expect(host.start(record, '/fixture', provider)).toMatchObject({ ok: true });
        expect(opened[0]!.env?.[variable(provider)]).toBeUndefined();
        expect(opened[0]!.env?.GENIE_MCP_TOKEN).toBe('fixture-bearer');
    });

    it.each(['claude', 'codex'] as const)('%s: the sign-in terminal and its status check carry no home variable', async provider => {
        const scratch = mkdtempSync(join(tmpdir(), 'genie-same-home-753-'));
        try {
            const opened: Array<{ env?: Readonly<Record<string, string>> | undefined }> = [];
            const statuses: Array<Readonly<Record<string, string>> | undefined> = [];
            const listeners: Array<(id: string, code: number) => void> = [];
            const login = new LoginHost({ accountFor: () => managed(provider), scratch: () => scratch, openWindow: () => {}, onSignedIn: () => {},
                terminals: { open: (o: (typeof opened)[number]) => { opened.push(o); return { id: 't1', pid: 1, shell: 'sh' }; }, close: () => true,
                    onExit: (l: (id: string, code: number) => void) => { listeners.push(l); return () => {}; } } as never,
                runStatus: async (_command: string, _cwd: string, env?: Readonly<Record<string, string>>) => { statuses.push(env); return 0; } });
            expect(login.start(provider)).toMatchObject({ ok: true });
            for (const l of listeners) l('t1', 0);
            await vi.waitFor(() => expect(statuses).toHaveLength(1));
            expect(opened[0]!.env?.[variable(provider)]).toBeUndefined();
            expect(statuses[0]?.[variable(provider)]).toBeUndefined();
        } finally { rmSync(scratch, { recursive: true, force: true }); }
    });

    it.each(['src/core/accounts.ts', 'src/main/session-host.ts', 'src/main/take-over-host.ts', 'src/main/login-host.ts', 'src/main/provider-health.ts',
        'src/main/account-identity.ts', 'src/main/genie-host.ts'])('%s has no per-account environment', path => {
        expect(source(path)).not.toContain('providerAccountEnv');
    });
});

describe('R2: the book records which known account is signed in', () => {
    let dir: string;
    let options: AccountsOptions;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-book-753-'));
        let n = 0;
        options = { root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'old-claude'), codex: join(dir, 'old-codex') },
            now: () => '2026-11-16T00:00:00.000Z', mintId: () => `account_${String(++n).padStart(32, '0')}` };
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('CONTROL: with nothing signed in each provider is on its legacy account, unknown', async () => {
        const book = await AccountsHost.open(options);
        expect(book.activeFor('claude')).toMatchObject({ id: 'account_legacy_claude', identity: identity(null) });
    });

    it('CONTROL: an identity with no email changes nothing', async () => {
        const book = await AccountsHost.open(options);
        await book.recordSignedIn('claude', identity(null));
        expect(book.list().filter(a => a.provider === 'claude')).toHaveLength(1);
        expect(book.activeFor('claude').id).toBe('account_legacy_claude');
    });

    it('the first email seen names the legacy placeholder: no phantom account is added', async () => {
        const book = await AccountsHost.open(options);
        await book.recordSignedIn('claude', identity(X));
        expect(book.list().filter(a => a.provider === 'claude')).toHaveLength(1);
        expect(book.activeFor('claude')).toMatchObject({ id: 'account_legacy_claude', label: X, identity: { email: X } });
    });

    it('a new email becomes a new known account, labelled by its email, active, with no folder made', async () => {
        const book = await AccountsHost.open(options);
        await book.recordSignedIn('claude', identity(X));
        const second = await book.recordSignedIn('claude', identity(Y));
        expect(second).toMatchObject({ label: Y, legacy: false, home: join(dir, 'old-claude') });
        expect(book.activeFor('claude').id).toBe(second!.id);
        expect(book.list().filter(a => a.provider === 'claude')).toHaveLength(2);
        expect(existsSync(join(dir, 'genie', 'accounts'))).toBe(false);
    });

    it('signing in as a known email again makes that account active, and adds nothing', async () => {
        const book = await AccountsHost.open(options);
        await book.recordSignedIn('claude', identity(X));
        await book.recordSignedIn('claude', identity(Y));
        await book.recordSignedIn('claude', identity(X.toUpperCase()));
        expect(book.list().filter(a => a.provider === 'claude')).toHaveLength(2);
        expect(book.activeFor('claude').id).toBe('account_legacy_claude');
    });

    it('a renamed account keeps its name when it is signed in again', async () => {
        const book = await AccountsHost.open(options);
        await book.recordSignedIn('claude', identity(X));
        await book.rename('account_legacy_claude', 'Work');
        await book.recordSignedIn('claude', identity(Y));
        await book.recordSignedIn('claude', identity(X));
        expect(book.activeFor('claude')).toMatchObject({ id: 'account_legacy_claude', label: 'Work' });
    });

    it('another provider is never touched', async () => {
        const book = await AccountsHost.open(options);
        await book.recordSignedIn('claude', identity(X));
        await book.recordSignedIn('claude', identity(Y));
        expect(book.activeFor('claude').identity.email).toBe(Y);
        expect(book.activeFor('codex')).toMatchObject({ id: 'account_legacy_codex', identity: identity(null) });
        expect(book.list().filter(a => a.provider === 'codex')).toHaveLength(1);
    });

    it('the active account and the known accounts are durable', async () => {
        const book = await AccountsHost.open(options);
        await book.recordSignedIn('claude', identity(X));
        const second = await book.recordSignedIn('claude', identity(Y));
        const again = await AccountsHost.open(options);
        expect(again.activeFor('claude').id).toBe(second!.id);
        expect(again.list().filter(a => a.provider === 'claude')).toHaveLength(2);
    });

    it('adding a known account makes no folder', async () => {
        const book = await AccountsHost.open(options);
        const added = await book.add({ provider: 'claude' });
        expect(added.home).toBe(join(dir, 'old-claude'));
        expect(existsSync(join(dir, 'genie', 'accounts'))).toBe(false);
    });
});

describe('R2: the identity read sets the active account', () => {
    let dir: string;
    let book: AccountsHost;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-reader-753-'));
        let n = 0;
        book = await AccountsHost.open({ root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'old-claude'), codex: join(dir, 'old-codex') },
            mintId: () => `account_${String(++n).padStart(32, '0')}` });
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const status = (email: string | null) => JSON.stringify({ loggedIn: email !== null, authMethod: 'claude.ai', ...(email ? { email } : {}) });
    const readerFor = (stdout: () => string) => new AccountIdentityReader(book, () => ({ platform: 'linux', arch: 'x64', env: { PATH: '/bin' },
        isFile: p => p === '/bin/claude', readText: () => '', readHead: () => null, realpath: p => p, chosen: () => null, now: () => 0,
        run: async () => ({ exitCode: 0, stdout: stdout(), streams: { stdout: stdout(), stderr: '' } }) }));

    it('after a switch the new email is the active account and the old one stays known', async () => {
        let email: string | null = X;
        const reader = readerFor(() => status(email));
        await reader.refreshProvider('claude');
        email = Y;
        await reader.refreshProvider('claude');
        expect(book.activeFor('claude')).toMatchObject({ label: Y, identity: { email: Y } });
        expect(book.list().filter(a => a.provider === 'claude').map(a => a.identity.email).sort()).toEqual([X, Y]);
    });

    it('a signed-out answer leaves the active account as it was', async () => {
        let email: string | null = X;
        const reader = readerFor(() => status(email));
        await reader.refreshProvider('claude');
        email = null;
        await reader.refreshProvider('claude');
        expect(book.activeFor('claude')).toMatchObject({ identity: { email: X } });
    });
});

describe('R2: usage after a switch is attributed to the new account', () => {
    let dir: string;
    let host: SessionHost;
    let book: AccountsHost;
    const events = new Map<string, DriverEvents>();
    const readings: Array<{ room: Headroom; stamp: ReadingStamp | undefined }> = [];
    const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
    const driverFor: DriverFor = (record) => {
        const factory: SessionDriverFactory = (options) => {
            events.set(record.name, options.events);
            return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
        };
        return factory;
    };
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-usage-753-'));
        readings.length = 0; events.clear();
        let n = 0;
        book = await AccountsHost.open({ root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'old-claude'), codex: join(dir, 'old-codex') },
            mintId: () => `account_${String(++n).padStart(32, '0')}` });
        host = new SessionHost({ userData: dir, driverFor, processTree: noTree, activeAccount: (provider: string) => book.activeFor(provider as AcpProvider),
            onHeadroom: (_provider: string, room: Headroom, stamp?: ReadingStamp) => { readings.push({ room, stamp }); } } as ConstructorParameters<typeof SessionHost>[0]);
    });
    afterEach(async () => { host.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
    const meta = (utilization: number) => ({
        sessionUpdate: 'notice', notice: { level: 'info', message: 'rate limit ok' },
        _meta: { 'particle.academy/rate_limit': { status: 'allowed', rateLimitType: 'five_hour', resetsAtMs: Date.now() + 3_600_000, windows: { five_hour: { utilization, resetsAtMs: Date.now() + 3_600_000 } }, raw: {} } },
    });

    it('a running agent’s reading is stamped with the account signed in after the switch', async () => {
        await book.recordSignedIn('claude', identity(X));
        const record: AgentRecord = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'atlas' });
        expect(host.start(record, dir)).toEqual({ ok: true });
        events.get('atlas')!.onUpdate?.(meta(0.4));
        const first = readings.at(-1)!.stamp!.accountId;
        const second = await book.recordSignedIn('claude', identity(Y));
        events.get('atlas')!.onUpdate?.(meta(0.5));
        expect(readings.at(-1)!.stamp!.accountId).toBe(second!.id);
        expect(second!.id).not.toBe(first);
        expect(host.probe(record.id)?.limit).toEqual({ state: 'open' });
    });
});
