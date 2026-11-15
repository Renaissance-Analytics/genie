import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexAccountReadInput, identityFieldWords, parseClaudeAuthStatus, parseCodexAccountRead } from '../src/core/account-identity.js';
import type { AccountRecord } from '../src/core/accounts.js';
import { AccountIdentityReader, readAccountIdentity } from '../src/main/account-identity.js';
import { AccountsHost } from '../src/main/accounts-host.js';
import type { ProviderHealthPorts } from '../src/main/provider-health.js';
import { execInProcess } from '../src/main/spawn-exec.js';

// Tynn #477 (Accounts S4): who an account is, as its provider reports it. Fixtures use no real person.
const EMAIL = 'person@example.test';
const claudeStatus = (extra: Record<string, unknown> = {}) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', configDirectory: '/genie/accounts/claude/a', ...extra });
const codexReply = (account: unknown) => `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { userAgent: 'codex' } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { account, requiresOpenaiAuth: true } })}\n`;

const record = (provider: 'claude' | 'codex', legacy: boolean, suffix = 'a'): AccountRecord => ({
    id: legacy ? `account_legacy_${provider}` : `account_${suffix.repeat(32)}`, provider, legacy, labelEdited: false, label: 'Account 1',
    home: legacy ? `/home/person/.${provider}` : `/genie/accounts/${provider}/${suffix}`, identity: { name: null, email: null, plan: null }, createdAt: '2026-11-15T00:00:00Z',
});

const portsFor = (run: ProviderHealthPorts['run'], env: Record<string, string | undefined> = { PATH: '/bin' }): ProviderHealthPorts => ({
    platform: 'linux', arch: 'x64', env, isFile: (p) => p === '/bin/claude' || p === '/bin/codex', readText: () => '', readHead: () => null,
    realpath: (p) => p, chosen: () => null, now: () => 0, run,
});
const answer = (stdout: string, exitCode = 0) => ({ exitCode, stdout, streams: { stdout, stderr: '' } });

describe('Claude identity comes only from the fields `claude auth status` reports', () => {
    it('reads email, name and plan when they are present', () => {
        expect(parseClaudeAuthStatus(claudeStatus({ email: EMAIL, name: 'Fixture Person', plan: 'max' }))).toEqual({ name: 'Fixture Person', email: EMAIL, plan: 'max' });
    });

    it('a status with no plan field yields plan unknown, never a guess', () => {
        const identity = parseClaudeAuthStatus(claudeStatus({ email: EMAIL }));
        expect(identity.plan).toBeNull();
        expect(identityFieldWords(identity.plan)).toBe('unknown');
        expect(identity.email).toBe(EMAIL);
        expect(identityFieldWords(identity.name)).toBe('unknown');
    });

    it('authMethod and configDirectory alone say nothing about who the person is', () => {
        expect(parseClaudeAuthStatus(claudeStatus())).toEqual({ name: null, email: null, plan: null });
    });

    it('never reads a key of another name in place of a missing one', () => {
        expect(parseClaudeAuthStatus(claudeStatus({ subscriptionType: 'pro', organization: 'Fixture Org', userEmail: EMAIL, accessToken: 'fixture-token' })))
            .toEqual({ name: null, email: null, plan: null });
    });

    it('text that is not JSON is unknown', () => {
        expect(parseClaudeAuthStatus('Not logged in')).toEqual({ name: null, email: null, plan: null });
    });
});

describe('Codex identity comes only from account/read with refreshToken:false', () => {
    it('the whole conversation is initialize, initialized, then account/read with refreshToken:false', () => {
        const frames = codexAccountReadInput().trim().split('\n').map((line) => JSON.parse(line) as { method: string; params?: unknown; id?: number });
        expect(frames.map((f) => f.method)).toEqual(['initialize', 'initialized', 'account/read']);
        expect(frames[2]!.params).toEqual({ refreshToken: false });
    });

    it('takes email and planType and nothing else', () => {
        expect(parseCodexAccountRead(codexReply({ type: 'chatgpt', email: EMAIL, planType: 'plus', idToken: 'fixture-token' }))).toEqual({ name: null, email: EMAIL, plan: 'plus' });
    });

    it('an unreported planType stays unknown', () => {
        const identity = parseCodexAccountRead(codexReply({ type: 'chatgpt', email: EMAIL }));
        expect(identity.plan).toBeNull();
        expect(identityFieldWords(identity.plan)).toBe('unknown');
    });

    it('no account, or no reply to account/read, is unknown', () => {
        expect(parseCodexAccountRead(codexReply(null))).toEqual({ name: null, email: null, plan: null });
        expect(parseCodexAccountRead(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`)).toEqual({ name: null, email: null, plan: null });
    });
});

describe('the reads run the provider in the account\'s own home', () => {
    it('Claude: `claude auth status` with the managed home, and the parsed identity', async () => {
        const run = vi.fn(async () => answer(claudeStatus({ email: EMAIL, plan: 'pro' })));
        const identity = await readAccountIdentity(record('claude', false), portsFor(run, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/elsewhere' }));
        expect(identity).toEqual({ name: null, email: EMAIL, plan: 'pro' });
        expect(run).toHaveBeenCalledTimes(1);
        const [binary, args, options] = run.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
        expect(binary).toBe('/bin/claude');
        expect(args).toEqual(['auth', 'status']);
        expect(options.env.CLAUDE_CONFIG_DIR).toBe('/genie/accounts/claude/a');
    });

    it('a legacy account inherits the parent environment exactly: an unset variable stays unset', async () => {
        const run = vi.fn(async () => answer(claudeStatus({ email: EMAIL })));
        await readAccountIdentity(record('claude', true), portsFor(run, { PATH: '/bin' }));
        const options = (run.mock.calls as unknown as unknown[][])[0]![2] as { env: Record<string, string> };
        expect(Object.keys(options.env).filter((k) => /^(CLAUDE_CONFIG_DIR|CODEX_HOME)$/i.test(k))).toEqual([]);
    });

    it('Codex: the App Server with CODEX_HOME, the account/read conversation as its input, and nothing else run', async () => {
        const run = vi.fn(async () => answer(codexReply({ type: 'chatgpt', email: EMAIL, planType: 'pro' })));
        const identity = await readAccountIdentity(record('codex', false, 'b'), portsFor(run));
        expect(identity).toEqual({ name: null, email: EMAIL, plan: 'pro' });
        expect(run).toHaveBeenCalledTimes(1);
        const [binary, args, options] = run.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; input: string }];
        expect(binary).toBe('/bin/codex');
        expect(args).toEqual(['app-server', '--listen', 'stdio://']);
        expect(options.env.CODEX_HOME).toBe('/genie/accounts/codex/b');
        expect(options.input).toBe(codexAccountReadInput());
    });

    it('a command that cannot run says nothing (null), never an invented identity', async () => {
        const failing = vi.fn(async () => { throw Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }); });
        expect(await readAccountIdentity(record('claude', false), portsFor(failing))).toBeNull();
        expect(await readAccountIdentity(record('claude', false), { ...portsFor(failing), isFile: () => false })).toBeNull();
    });
});

describe('the reader feeds AccountsHost.recordIdentity', () => {
    let dir = '';
    afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

    it('records each account, the label follows the email unless the person renamed it, and an unchanged identity is not rewritten', async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-identity-477-'));
        const host = await AccountsHost.open({ root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'old-claude'), codex: join(dir, 'old-codex') } });
        const run = vi.fn(async (binary: string) => answer(binary.endsWith('claude') ? claudeStatus({ email: EMAIL }) : codexReply({ type: 'chatgpt', email: 'second@example.test', planType: 'team' })));
        const reader = new AccountIdentityReader(host, () => portsFor(run));
        await reader.refreshAll();
        expect(host.get('account_legacy_claude')).toMatchObject({ label: EMAIL, identity: { email: EMAIL, plan: null, name: null } });
        expect(host.get('account_legacy_codex')).toMatchObject({ label: 'second@example.test', identity: { email: 'second@example.test', plan: 'team' } });
        await host.rename('account_legacy_claude', 'Work');
        run.mockImplementation(async () => answer(claudeStatus({ email: 'third@example.test' })));
        await reader.refreshProvider('claude');
        expect(host.get('account_legacy_claude')).toMatchObject({ label: 'Work', identity: { email: 'third@example.test' } });
        const spy = vi.spyOn(host, 'recordIdentity');
        await reader.refreshProvider('claude');
        expect(spy).not.toHaveBeenCalled();
    });

    it('a failed read keeps the last identity', async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-identity-477-'));
        const host = await AccountsHost.open({ root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'old-claude'), codex: join(dir, 'old-codex') } });
        const good = vi.fn(async () => answer(claudeStatus({ email: EMAIL })));
        await new AccountIdentityReader(host, () => portsFor(good)).refreshProvider('claude');
        const bad = vi.fn(async () => { throw new Error('timed out'); });
        await new AccountIdentityReader(host, () => portsFor(bad)).refreshProvider('claude');
        expect(host.get('account_legacy_claude')!.identity.email).toBe(EMAIL);
    });
});

describe('the spawn runner can hold a command\'s input open until its reply', () => {
    it('writes the input and ends it only when the output matches', async () => {
        const script = [
            "let got = '';",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data', (c) => { if (got === '') process.stdout.write('{\"id\":2}\\n'); got += c; });",
            "process.stdin.on('end', () => process.stdout.write('ended after:' + JSON.stringify(got)));",
        ].join('\n');
        const result = await execInProcess(process.execPath, ['-e', script], { input: 'hello\n', endInputOnOutput: '"id":2', timeoutMs: 15_000 });
        expect(result.stdout).toContain('{"id":2}');
        expect(result.stdout).toContain('ended after:"hello\\n"');
    });
});
