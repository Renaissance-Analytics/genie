import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ClaudeAccountCheck, ClaudeAccountStatus } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountsActionOf } from '../src/core/account-settings.js';
import { claudeConfigDirOf, claudeLiveOf, respawnDecision, type RespawnInput } from '../src/core/claude-accounts.js';
import { AccountsHost, type AccountsOptions } from '../src/main/accounts-host.js';
import { linkSharedSessions, SHARED_SESSION_FOLDERS, type SessionLinkFs } from '../src/main/claude-account-dirs.js';
import { LoginHost } from '../src/main/login-host.js';
import { claudeDriverAccountOptions } from '../src/main/session-host.js';

// Tynn #1011: Claude accounts as configuration directories (prism-acp 0.45.0 claudeAccounts). Genie keeps a label, the
// email or organization the CLI reported, the method the person chose and the directory path: never a key, a token or a read
// of a credential file. Threads are shared: each account dir's session history is a link to ONE store.

let dir: string;
let options: AccountsOptions;
let nextId: number;
const NOW = '2026-11-21T18:00:00.000Z';
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-1011-'));
    nextId = 0;
    options = { root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'home', '.claude'), codex: join(dir, 'home', '.codex') },
        now: () => NOW, mintId: () => `account_${String(++nextId).padStart(32, '0')}`, sharedSessionStore: join(dir, 'home', '.claude', 'projects') };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the book: one configuration directory per added Claude account', () => {
    it('adds a Claude account with its own directory under Genie\'s data, the method chosen, and nothing else', async () => {
        const book = await AccountsHost.open(options);
        const added = await book.addClaude({ method: 'console' });
        expect(added.configDir).toBe(resolve(options.root, 'accounts', 'claude', added.id));
        expect(added.method).toBe('console');
        expect(added.provider).toBe('claude');
        expect(added.label).toBe('Account 2');
        expect(added.legacy).toBe(false);
        // Durable, and only the allowed fields: no key, token or anything like one.
        const stored = JSON.parse(await readFile(join(options.root, 'runtime', 'accounts.json'), 'utf8'));
        const row = stored.accounts.find((a: { id: string }) => a.id === added.id);
        expect(Object.keys(row).sort()).toEqual(['configDir', 'createdAt', 'home', 'id', 'identity', 'label', 'labelEdited', 'legacy', 'method', 'provider']);
        expect(JSON.stringify(stored)).not.toMatch(/token|secret|apiKey|sk-ant/i);
        const again = await AccountsHost.open(options);
        expect(again.get(added.id)).toEqual(added);
    });

    it('makes the directory and links its session history to the shared store when it adds the account', async () => {
        const book = await AccountsHost.open(options);
        const added = await book.addClaude({ method: 'subscription', label: 'Work' });
        expect(added.label).toBe('Work');
        const link = join(added.configDir!, 'projects');
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(resolve(await readlink(link))).toBe(resolve(options.sharedSessionStore!));
    });

    it('refuses a book row whose directory is relative, or a directory on a Codex account', async () => {
        await mkdir(join(options.root, 'runtime'), { recursive: true });
        const legacy = (p: string) => ({ id: `account_legacy_${p}`, provider: p, label: 'Account 1', labelEdited: false, home: join(dir, p), legacy: true, identity: { name: null, email: null, plan: null }, createdAt: NOW });
        const bad = (row: Record<string, unknown>) => writeFile(join(options.root, 'runtime', 'accounts.json'), JSON.stringify({ version: 1, accounts: [legacy('claude'), legacy('codex'), row] }));
        const base = { id: `account_${'1'.repeat(32)}`, label: 'X', labelEdited: false, home: join(dir, 'h'), legacy: false, identity: { name: null, email: null, plan: null }, createdAt: NOW, method: 'subscription' };
        await bad({ ...base, provider: 'claude', configDir: 'relative/dir' });
        await expect(AccountsHost.open(options)).rejects.toThrow();
        await bad({ ...base, provider: 'codex', configDir: join(dir, 'c') });
        await expect(AccountsHost.open(options)).rejects.toThrow();
        await bad({ ...base, provider: 'claude', configDir: join(dir, 'c'), method: 'magic' });
        await expect(AccountsHost.open(options)).rejects.toThrow();
    });

    it('the default account is the CLI default (configDir null); an added account is its directory', async () => {
        const book = await AccountsHost.open(options);
        const added = await book.addClaude({ method: 'subscription' });
        expect(claudeConfigDirOf(book.activeFor('claude'))).toBeNull();
        expect(claudeConfigDirOf(added)).toBe(added.configDir);
    });

    it('a sign-in read of the DEFAULT home never makes an account with its own directory active, even with the same email', async () => {
        const book = await AccountsHost.open(options);
        const own = await book.addClaude({ method: 'subscription' });
        await book.recordIdentity(own.id, { name: null, email: 'person@example.test', plan: 'max' });
        await book.recordSignedIn('claude', { name: null, email: 'person@example.test', plan: 'max' });
        expect(book.activeFor('claude').id).not.toBe(own.id);
        // The default home's own account took it, as before (Tynn #753).
        expect(book.activeFor('claude').configDir ?? null).toBeNull();
    });

    it('switching is choosing: setActive makes the account with its own directory the one every agent uses', async () => {
        const book = await AccountsHost.open(options);
        const own = await book.addClaude({ method: 'console' });
        await book.setActive('claude', own.id);
        expect(book.activeFor('claude').id).toBe(own.id);
        expect((await AccountsHost.open(options)).activeFor('claude').id).toBe(own.id);
    });
});

describe('linkSharedSessions: the one place an account directory gets the shared session history (swappable for prism-acp)', () => {
    it('links only session-history folders, never anything credential-bearing', () => {
        expect(SHARED_SESSION_FOLDERS).toContain('projects');
        for (const name of SHARED_SESSION_FOLDERS) expect(name).not.toMatch(/credential|auth|key|\.json$|keychain|settings/i);
    });

    it('is idempotent: a link already pointing at the store is left as it is', async () => {
        const store = join(dir, 'store'), account = join(dir, 'acct');
        expect(linkSharedSessions(account, store)).toEqual({ ok: true });
        expect(linkSharedSessions(account, store)).toEqual({ ok: true });
        expect(resolve(await readlink(join(account, 'projects')))).toBe(resolve(store));
    });

    it('refuses to replace a REAL folder, and leaves it and its contents untouched', async () => {
        const store = join(dir, 'store'), account = join(dir, 'acct');
        await mkdir(join(account, 'projects'), { recursive: true });
        await writeFile(join(account, 'projects', 'keep.jsonl'), 'history');
        const result = linkSharedSessions(account, store);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toMatch(/projects/);
        expect((await lstat(join(account, 'projects'))).isSymbolicLink()).toBe(false);
        expect(await readFile(join(account, 'projects', 'keep.jsonl'), 'utf8')).toBe('history');
    });

    it('refuses a link that points somewhere else', async () => {
        const store = join(dir, 'store'), account = join(dir, 'acct');
        linkSharedSessions(account, join(dir, 'other'));
        expect(linkSharedSessions(account, store).ok).toBe(false);
    });

    it('a junction on Windows, a directory symlink elsewhere; it never reads a session file', () => {
        for (const platform of ['win32', 'linux', 'darwin'] as const) {
            const calls: string[] = [];
            const fs: SessionLinkFs = {
                mkdir: (p) => { calls.push(`mkdir ${p}`); },
                lstat: () => null,
                readlink: () => { throw new Error('no link'); },
                symlink: (target, path, type) => { calls.push(`symlink ${type}`); },
            };
            expect(linkSharedSessions('/acct', '/store', { fs, platform })).toEqual({ ok: true });
            expect(calls.filter((c) => c.startsWith('symlink'))).toEqual(SHARED_SESSION_FOLDERS.map(() => `symlink ${platform === 'win32' ? 'junction' : 'dir'}`));
        }
        // The ports have no read of a file's contents at all: the type has none to call.
        const ports: Array<keyof SessionLinkFs> = ['mkdir', 'lstat', 'readlink', 'symlink'];
        expect(ports).not.toContain('readFile' as keyof SessionLinkFs);
    });
});

const status = (over: Partial<ClaudeAccountStatus> = {}): ClaudeAccountStatus => ({
    signedIn: true, method: 'subscription', cliAuthMethod: 'claude.ai', billing: 'subscription', email: 'person@example.test',
    organizationId: 'org-1', organizationName: 'Example Org', subscriptionType: 'max', requestedConfigDir: '/acct',
    configDirectory: '/acct', configDirectoryMatches: true, loginExpiresAt: '2026-12-01T00:00:00Z', withheld: ['ANTHROPIC_API_KEY'], ...over,
});

describe('claudeLiveOf: what the popover shows of an account, from describe and check (typed, no text parsed)', () => {
    it('keeps exactly the fields the person sees', () => {
        const s = status();
        expect(claudeLiveOf(s, { state: 'ready', account: s })).toEqual({
            signedIn: true, method: 'subscription', billing: 'subscription', email: 'person@example.test', org: 'Example Org',
            plan: 'max', loginExpiresAt: '2026-12-01T00:00:00Z', directoryMatched: true, check: { state: 'ready', differences: [] },
        });
    });

    it('a mismatch carries the typed differences', () => {
        const s = status({ method: 'apiKey', billing: 'apiUsage', apiKeySource: 'apiKeyHelper' });
        const check: ClaudeAccountCheck = { state: 'mismatch', account: s, expected: { configDir: '/acct', method: 'subscription' }, differences: ['method'] };
        expect(claudeLiveOf(s, check).check).toEqual({ state: 'mismatch', differences: ['method'] });
    });

    it('an unreported field is null, never guessed; the org falls back to its id', () => {
        const s = status({ email: undefined, organizationName: undefined, subscriptionType: undefined, loginExpiresAt: null, signedIn: false, method: 'none', billing: 'none' });
        const live = claudeLiveOf(s, { state: 'signedOut', account: s });
        expect(live).toMatchObject({ email: null, org: 'org-1', plan: null, loginExpiresAt: null, signedIn: false, check: { state: 'signedOut', differences: [] } });
    });
});

describe('accountsActionOf: the new account actions, checked', () => {
    it('accepts add (subscription or console), sign in and switch', () => {
        expect(accountsActionOf({ kind: 'add-claude', method: 'console' })).toEqual({ kind: 'add-claude', method: 'console' });
        expect(accountsActionOf({ kind: 'add-claude', method: 'subscription', label: 'Work' })).toEqual({ kind: 'add-claude', method: 'subscription', label: 'Work' });
        expect(accountsActionOf({ kind: 'sign-in', id: 'account_x' })).toEqual({ kind: 'sign-in', id: 'account_x' });
        expect(accountsActionOf({ kind: 'set-active', id: 'account_x' })).toEqual({ kind: 'set-active', id: 'account_x' });
    });
    it('refuses anything else', () => {
        expect(accountsActionOf({ kind: 'add-claude', method: 'oauth-token' })).toBeNull();
        expect(accountsActionOf({ kind: 'add-claude' })).toBeNull();
        expect(accountsActionOf({ kind: 'set-active' })).toBeNull();
        expect(accountsActionOf({ kind: 'add-claude', method: 'console', key: 'sk-ant-x' })).toEqual({ kind: 'add-claude', method: 'console' });
    });
});

const idle: RespawnInput = { launchedConfigDir: '/a', activeConfigDir: '/b', inTurn: false, pendingApproval: false, pendingQuestion: false, backgroundRunning: false, queued: 0, threadId: 'thread-1', store: 'present' };

describe('respawnDecision: a switch reaches a running agent only at a clean idle, on the same thread, never forked', () => {
    it('nothing to do when the run already uses the active account', () => {
        expect(respawnDecision({ ...idle, activeConfigDir: '/a' })).toEqual({ kind: 'stay' });
        expect(respawnDecision({ ...idle, launchedConfigDir: null, activeConfigDir: null })).toEqual({ kind: 'stay' });
    });
    it('waits while a turn, a tool, an approval, a question or a queued message is in hand', () => {
        for (const busy of [{ inTurn: true }, { backgroundRunning: true }, { pendingApproval: true }, { pendingQuestion: true }, { queued: 1 }]) {
            expect(respawnDecision({ ...idle, ...busy })).toEqual({ kind: 'wait' });
        }
    });
    it('re-spawns on the SAME thread at a clean idle when the store has it under the new account', () => {
        expect(respawnDecision(idle)).toEqual({ kind: 'respawn', threadId: 'thread-1' });
    });
    it('an agent with no thread yet re-spawns fresh: there is nothing to fork', () => {
        expect(respawnDecision({ ...idle, threadId: null, store: 'absent' })).toEqual({ kind: 'respawn', threadId: null });
    });
    it('a thread the new account cannot find (or cannot say) is never forked: the agent stays and is told', () => {
        for (const store of ['absent', 'indeterminate'] as const) {
            const d = respawnDecision({ ...idle, store });
            expect(d.kind).toBe('note');
        }
    });
});

describe('signing in to an account with its own directory: prism-acp loginCommand, in a terminal the person sees', () => {
    const perDir = (method: 'subscription' | 'console') => ({ id: `account_${'7'.repeat(32)}`, provider: 'claude' as const, label: 'Work', labelEdited: true,
        home: '/home/.claude', legacy: false, identity: { name: null, email: 'person@example.test', plan: null }, createdAt: NOW,
        configDir: resolve(dir, 'acct'), method });

    function fixture(account: ReturnType<typeof perDir>) {
        const opened: Array<{ command?: string; env?: Readonly<Record<string, string>>; cwd: string }> = [];
        const windows: string[] = [];
        const login = new LoginHost({
            terminals: { open: (o) => { opened.push(o); return { id: `t${opened.length}` } as never; }, onExit: () => () => {}, close: () => {} } as never,
            openWindow: (route) => { windows.push(route); },
            runStatus: async () => 0,
            accountFor: () => account,
            onSignedIn: () => {},
            scratch: () => dir,
            parentEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-parent-should-not-pass', CLAUDE_CODE_OAUTH_TOKEN: 'x' },
        });
        return { login, opened, windows };
    }

    it.each([['subscription', '--claudeai'], ['console', '--console']] as const)('%s: the CLI\'s own login with %s, in that directory, credentials withheld', (method, flag) => {
        const f = fixture(perDir(method));
        const started = f.login.start('claude', `account_${'7'.repeat(32)}`);
        expect(started.ok).toBe(true);
        expect(f.opened).toHaveLength(1);
        expect(f.opened[0]!.command).toMatch(new RegExp(`auth login ${flag}( |$)`));
        expect(f.opened[0]!.env?.CLAUDE_CONFIG_DIR).toBe(resolve(dir, 'acct'));
        expect(Object.keys(f.opened[0]!.env ?? {})).not.toContain('ANTHROPIC_API_KEY');
        expect(Object.keys(f.opened[0]!.env ?? {})).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
        // Visible: the person's window is opened on that terminal.
        expect(f.windows).toHaveLength(1);
    });
});

describe('launching on the active account: the driver gets its configuration directory', () => {
    it('the default account launches with configDir null; an account with its own directory with that directory', () => {
        expect(claudeDriverAccountOptions({ legacy: true })).toEqual({ configDir: null });
        expect(claudeDriverAccountOptions({ legacy: false })).toEqual({ configDir: null });
        expect(claudeDriverAccountOptions({ legacy: false, configDir: '/genie/accounts/claude/x' })).toEqual({ configDir: '/genie/accounts/claude/x' });
        expect(claudeDriverAccountOptions(undefined)).toEqual({});
    });
});
