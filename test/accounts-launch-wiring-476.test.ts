import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_LINK_LABEL } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import { SessionEngineClient, type EngineClientOptions } from '../src/main/session-engine-client.js';
import { SessionEngineServer, type EngineServerOptions } from '../src/main/session-engine-server.js';
import { LoginHost } from '../src/main/login-host.js';
import { TakeOverHost } from '../src/main/take-over-host.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';

const close: Array<() => void> = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); vi.unstubAllEnvs(); });
async function connection(extra: Partial<EngineServerOptions> = {}, local = true, options: EngineClientOptions = {}) {
    const server = new SessionEngineServer({ token: 'fixture', build: 'fixture', ...extra });
    const client = new SessionEngineClient(options), [host, window] = memoryPair();
    server.accept(host, { local }); close.push(() => window.close());
    expect(await client.connect(window, 'fixture')).toMatchObject({ ok: true });
    return client;
}

describe('S3: the persisted home reaches the existing login without opening an account book in the window', () => {
    it('the local window gets only the persisted legacy id/provider/home and inheritance flag, before agent sessions exist', async () => {
        const client = await connection({ providerAccount: provider => provider === 'claude'
            ? { id: 'account_legacy_claude', provider: 'claude', home: '/profile/custom claude', legacy: true, label: 'not needed by login' } as never : null });
        expect(await client.providerAccount('claude')).toEqual({ id: 'account_legacy_claude', provider: 'claude', home: '/profile/custom claude', legacy: true });
        expect(await client.providerAccount('unknown')).toBeNull();
    });
    it('an unavailable book gives an explicit refusal and the client keeps the account unknown', async () => {
        const client = await connection();
        expect(await client.call('engine.providerAccount', ['claude'])).toEqual({ ok: false, reason: 'The provider account book is unavailable.' });
        expect(await client.providerAccount('claude')).toBeNull();
    });
    it.each([['another connection', false, {}], ['the browser', true, { label: BROWSER_LINK_LABEL }]] as const)
       ('%s keeps its existing scope', async (_name, local, options) => {
            const client = await connection({ providerAccount: () => { throw new Error('the book must not be read'); } }, local, options);
            expect(await client.call('engine.providerAccount', ['claude'])).toEqual({ ok: false, reason: 'Provider account homes need this machine’s own window.' });
        });
    it('login reports an unknown account visibly before opening a terminal or asking for scratch space', () => {
        const login = new LoginHost({
            accountFor: () => null,
            terminals: { open: () => { throw new Error('a terminal must not open'); }, onExit: () => () => {} } as never,
            scratch: () => { throw new Error('scratch must not be touched'); }, openWindow: () => {}, onSignedIn: () => {}, runStatus: async () => 1,
        });
        expect(login.start('claude')).toEqual({ ok: false, reason: 'The provider account is unavailable; reconnect Genie’s host before logging in.' });
    });
    it('the production owners resolve launch and legacy probes from the host book, and reload login homes on reconnect', () => {
        const source = (name: string) => readFileSync(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8');
        const host = source('genie-host'), window = source('main');
        expect(host).toMatch(/accountById: id => accounts\.get\(id\)/);
        expect(host).toMatch(/providerAccount: provider => isAcpProvider\(provider\) \? accounts\.defaultFor\(provider\) : null/);
        expect(host).toMatch(/realListModels\(provider, accounts\.defaultFor\(provider\) \?\? undefined\)/);
        expect(host).toMatch(/checkProviderHealth\(provider, realProviderHealthPorts\(execFileRunner\), accounts\.defaultFor\(provider\) \?\? undefined\)/);
        expect(host).toMatch(/env: providerAccountEnv\(account, process\.env\)/);
        expect(window).toMatch(/accountFor: provider => loginAccounts\.get\(provider\) \?\? null/);
        expect(window).toMatch(/void refreshLoginAccounts\?\.\(client\)\.catch\(/);
        expect(window).toMatch(/const account = await client\.providerAccount\(provider\)/);
        expect(window).toMatch(/runStatus: \(command, cwd, env\) => execFileRunner\(/);
        expect(window).not.toMatch(/AccountsHost\.open/);
    });
});


describe('S3: the observed Take Over TUI keeps the bound account', () => {
    function fixture(provider: 'claude' | 'codex', selected: 'matching' | 'missing' | 'mismatched' = 'matching', mcp = true, legacy = false) {
        const opened: Array<{ env?: Readonly<Record<string, string>> | undefined }> = [];
        const record = { ...agentRecord({ id: mintAgentId(), name: 'fixture', provider, workspaceId: 'fixture' }), accountId: `account_${'a'.repeat(32)}` };
        const account = { provider: selected === 'mismatched' ? (provider === 'claude' ? 'codex' as const : 'claude' as const) : provider,
            home: `/genie/accounts/${provider}/selected`, legacy };
        const host = new TakeOverHost({ accountFor: () => selected === 'missing' ? null : account,
            terminals: { open: (options: (typeof opened)[number]) => { opened.push(options); return { id: 'fixture-terminal' }; },
                close: () => true, onData: () => () => {}, onExit: () => () => {} } as never,
            openWindow: () => {}, mcp: () => mcp ? { mcpUrl: 'http://127.0.0.1:9/mcp', token: 'fixture-bearer' } : null });
        return { host, record, account, opened };
    }
    it.each(['claude', 'codex'] as const)('%s Take Over launches in the selected home beside its own MCP attribution', provider => {
        const f = fixture(provider);
        expect(f.host.start(f.record, '/fixture', provider)).toMatchObject({ ok: true });
        const env = f.opened[0]!.env!;
        expect(env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']).toBe(f.account.home);
        expect(env.GENIE_MCP_TOKEN).toBe('fixture-bearer');
        expect(env.GENIE_TERMINAL_ID).toMatch(/^takeover_/);
        expect(f.host.callerFor(env.GENIE_TERMINAL_ID!)).toMatchObject({ agentId: f.record.id });
    });
    it.each(['missing', 'mismatched'] as const)('%s Take Over account refuses before opening a terminal', selected => {
        const f = fixture('claude', selected);
        expect(f.host.start(f.record, '/fixture', 'claude')).toMatchObject({ ok: false, reason: expect.stringMatching(/account/) });
        expect(f.opened).toEqual([]);
    });
    it('a home without an MCP server invents no MCP caller or token', () => {
        const f = fixture('claude', 'matching', false);
        expect(f.host.start(f.record, '/fixture', 'claude')).toMatchObject({ ok: true });
        expect(f.opened[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: f.account.home });
        expect(f.host.callers()).toEqual({});
    });
    it.each(['claude', 'codex'] as const)('%s legacy Take Over keeps an unset home unset beside its MCP attribution', provider => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', undefined); vi.stubEnv('CODEX_HOME', undefined);
        const f = fixture(provider, 'matching', true, true);
        expect(f.host.start(f.record, '/fixture', provider)).toMatchObject({ ok: true });
        const env = f.opened[0]!.env!;
        expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
        expect(env).not.toHaveProperty('CODEX_HOME');
        expect(env.GENIE_MCP_TOKEN).toBe('fixture-bearer');
        expect(f.host.callerFor(env.GENIE_TERMINAL_ID!)).toMatchObject({ agentId: f.record.id });
    });
});
