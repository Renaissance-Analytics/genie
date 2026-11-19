import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginHost } from '../src/main/login-host.js';
import { TakeOverHost } from '../src/main/take-over-host.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';

const close: Array<() => void> = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); vi.unstubAllEnvs(); });

describe('S3: the persisted home reaches the existing login without opening an account book in the window', () => {
    // The window no longer asks for a provider's account home: its provider health was main's duplicate of genie-host's,
    // and engine.providerAccount is retired (Tynn #896, 2b-3; test/split-2b3-provider-account.test.ts).
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
        // Tynn #751: ONE active account per provider; every launch and probe reads it, never an agent's own.
        expect(host).toMatch(/activeAccount: provider => isAcpProvider\(provider\) \? accounts\.activeFor\(provider\) : null/);
        expect(host).not.toMatch(/providerAccount: provider =>/); // retired in 2b-3 (Tynn #896)
        expect(host).toMatch(/realListModels\(provider, accounts\.activeFor\(provider\)\)/);
        expect(host).toMatch(/checkProviderHealth\(provider, realProviderHealthPorts\(execFileRunner\), accounts\.activeFor\(provider\)\)/);
        // Tynn #753: ONE HOME PER PROVIDER, so nothing here builds an environment for an account.
        expect(host).not.toContain('providerAccountEnv');
        // S6 (Tynn #479): the sign-in runs in the host, per account, from the host book; the window opens no book and runs no status.
        expect(host).toMatch(/accountFor: \(provider, accountId\) => \{[\s\S]{0,200}accounts\.get\(accountId\)/);
        expect(host).toMatch(/runStatus: \(command, cwd\) => execFileRunner\(/);
        expect(window).not.toMatch(/new LoginHost/);
        expect(window).not.toMatch(/AccountsHost\.open/);
    });
});


describe('S3 (R1, Tynn #751): the observed Take Over TUI uses the provider active account', () => {
    function fixture(provider: 'claude' | 'codex', selected: 'matching' | 'missing' | 'mismatched' = 'matching', mcp = true, legacy = false) {
        const opened: Array<{ env?: Readonly<Record<string, string>> | undefined }> = [];
        const record = agentRecord({ id: mintAgentId(), name: 'fixture', provider, workspaceId: 'fixture' });
        const account = { provider: selected === 'mismatched' ? (provider === 'claude' ? 'codex' as const : 'claude' as const) : provider,
            home: `/genie/accounts/${provider}/selected`, legacy };
        const host = new TakeOverHost({ accountFor: () => selected === 'missing' ? null : account,
            terminals: { open: (options: (typeof opened)[number]) => { opened.push(options); return { id: 'fixture-terminal' }; },
                close: () => true, onData: () => () => {}, onExit: () => () => {} } as never,
            openWindow: () => {}, mcp: () => mcp ? { mcpUrl: 'http://127.0.0.1:9/mcp', token: 'fixture-bearer' } : null });
        return { host, record, account, opened };
    }
    it.each(['claude', 'codex'] as const)('%s Take Over sets no home variable beside its own MCP attribution (Tynn #753)', provider => {
        const f = fixture(provider);
        expect(f.host.start(f.record, '/fixture', provider)).toMatchObject({ ok: true });
        const env = f.opened[0]!.env!;
        expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
        expect(env).not.toHaveProperty('CODEX_HOME');
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
        expect(f.opened[0]!.env).toBeUndefined();
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
