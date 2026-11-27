import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ClaudeAccountCheck, ClaudeAccountStatus } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountsActionOf } from '../src/core/account-settings.js';
import { CLAUDE_SIGNS_IN_IN_THE_BROWSER, claudeConfigDirOf, claudeLiveOf, respawnDecision, type RespawnInput } from '../src/core/claude-accounts.js';
import { AccountsHost, type AccountsOptions } from '../src/main/accounts-host.js';
import { LoginHost } from '../src/main/login-host.js';
import { ClaudeAccountsLive } from '../src/main/claude-accounts-live.js';
import { AccountIdentityReader } from '../src/main/account-identity.js';
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

// The linking itself is prism-acp's (0.46.0 prepare): test/claude-accounts-prepare-1011.test.ts.

// A field given as `undefined` is LEFT OUT, as prism-acp leaves out what the CLI did not print.
const status = (over: { [K in keyof ClaudeAccountStatus]?: ClaudeAccountStatus[K] | undefined } = {}): ClaudeAccountStatus => Object.fromEntries(Object.entries({
    signedIn: true, method: 'subscription', cliAuthMethod: 'claude.ai', billing: 'subscription', email: 'person@example.test',
    organizationId: 'org-1', organizationName: 'Example Org', subscriptionType: 'max', requestedConfigDir: '/acct',
    configDirectory: '/acct', configDirectoryMatches: true, loginExpiresAt: '2026-12-01T00:00:00Z', withheld: ['ANTHROPIC_API_KEY'], ...over,
}).filter(([, v]) => v !== undefined)) as unknown as ClaudeAccountStatus;

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
    it('accepts add (subscription or console) and switch', () => {
        expect(accountsActionOf({ kind: 'add-claude', method: 'console' })).toEqual({ kind: 'add-claude', method: 'console' });
        expect(accountsActionOf({ kind: 'add-claude', method: 'subscription', label: 'Work' })).toEqual({ kind: 'add-claude', method: 'subscription', label: 'Work' });
        // Signing in is the browser one (prism-acp login(), Tynn #1011): an account action, no window, no terminal.
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

describe('an account with its own directory is never signed in through a terminal (the owner: "I should not see any terminals")', () => {
    const perDir = (method: 'subscription' | 'console') => ({ id: `account_${'7'.repeat(32)}`, provider: 'claude' as const, label: 'Work', labelEdited: true,
        home: '/home/.claude', legacy: false, identity: { name: null, email: 'person@example.test', plan: null }, createdAt: NOW,
        configDir: resolve(dir, 'acct'), method });

    function fixture(account: ReturnType<typeof perDir>) {
        const opened: Array<{ command?: string; env?: Readonly<Record<string, string>>; cwd: string }> = [];
        const windows: string[] = [];
        const login = new LoginHost({
            terminals: { open: (o: { command?: string; env?: Readonly<Record<string, string>>; cwd: string }) => { opened.push(o); return { id: `t${opened.length}` } as never; }, onExit: () => () => {}, close: () => {} } as never,
            openWindow: (route) => { windows.push(route); },
            runStatus: async () => 0,
            accountFor: () => account,
            onSignedIn: () => {},
            scratch: () => dir,
        });
        return { login, opened, windows };
    }

    it.each(['subscription', 'console'] as const)('%s: refused with the words for later; no terminal, no window', (method) => {
        const f = fixture(perDir(method));
        expect(f.login.start('claude', `account_${'7'.repeat(32)}`)).toEqual({ ok: false, reason: CLAUDE_SIGNS_IN_IN_THE_BROWSER });
        expect(f.opened).toEqual([]);
        expect(f.windows).toEqual([]);
    });

    it('the default account too: every Claude sign-in is the browser one now; CONTROL: another provider\'s login still opens', () => {
        const { configDir: _c, method: _m, ...home } = perDir('subscription');
        const f = fixture(home as ReturnType<typeof perDir>);
        expect(f.login.start('claude', `account_${'7'.repeat(32)}`)).toEqual({ ok: false, reason: CLAUDE_SIGNS_IN_IN_THE_BROWSER });
        expect(f.opened).toEqual([]);
        const codex = fixture({ ...(home as ReturnType<typeof perDir>), provider: 'codex' as never });
        expect(codex.login.start('codex', `account_${'7'.repeat(32)}`).ok).toBe(true);
        expect(codex.opened).toHaveLength(1);
    });
});

describe('launching on the active account: the driver gets its configuration directory', () => {
    it('the default account launches with configDir null; an account with its own directory with that directory', () => {
        expect(claudeDriverAccountOptions({ legacy: true })).toEqual({ configDir: null });
        expect(claudeDriverAccountOptions({ legacy: false })).toEqual({ configDir: null });
        expect(claudeDriverAccountOptions({ legacy: false, configDir: '/genie/accounts/claude/x' })).toEqual({ configDir: '/genie/accounts/claude/x' });
        expect(claudeDriverAccountOptions(undefined)).toEqual({});
        // The default home Genie itself was started with is still the default: nothing about it changes.
        expect(claudeDriverAccountOptions({ legacy: true }, { CLAUDE_CONFIG_DIR: '/custom/claude' })).toEqual({ configDir: '/custom/claude' });
        expect(claudeDriverAccountOptions({ legacy: false, configDir: '/own' }, { CLAUDE_CONFIG_DIR: '/custom/claude' })).toEqual({ configDir: '/own' });
    });
});

describe('ClaudeAccountsLive: each account\'s live state, asked of the CLI in that account\'s own directory', () => {
    const rec = (id: string, extra: Record<string, unknown> = {}) => ({ id, provider: 'claude' as const, label: id, labelEdited: false, home: '/home/.claude', legacy: id === 'account_legacy_claude',
        identity: { name: null, email: null, plan: null }, createdAt: NOW, ...extra });

    it('an account with its own directory is described there and checked against what the person chose; its email is recorded', async () => {
        const asked: Array<string | null> = [];
        const recorded: Array<[string, string | null]> = [];
        const own = rec(`account_${'3'.repeat(32)}`, { configDir: '/genie/accounts/claude/x', method: 'subscription' });
        const live = new ClaudeAccountsLive({
            accounts: () => [rec('account_legacy_claude'), own],
            describe: async (dir) => { asked.push(dir); return dir === '/genie/accounts/claude/x' ? status({ requestedConfigDir: dir, configDirectory: dir }) : status({ requestedConfigDir: null, configDirectory: '/home/.claude', email: 'other@example.test' }); },
            defaultDir: () => null,
            recordIdentity: async (id, identity) => { recorded.push([id, identity.email]); },
            changed: () => {},
        });
        await live.refresh();
        expect(asked.sort()).toEqual([null, '/genie/accounts/claude/x'].sort());
        expect(live.view()[own.id]).toMatchObject({ signedIn: true, email: 'person@example.test', check: { state: 'ready', differences: [] } });
        expect(recorded).toContainEqual([own.id, 'person@example.test']);
    });

    it('a Console login where the person chose a subscription is a MISMATCH, typed', async () => {
        const own = rec(`account_${'4'.repeat(32)}`, { configDir: '/d', method: 'subscription' });
        const live = new ClaudeAccountsLive({
            accounts: () => [own], defaultDir: () => null, recordIdentity: async () => {}, changed: () => {},
            describe: async (dir) => status({ requestedConfigDir: dir, configDirectory: dir ?? undefined, method: 'console', billing: 'apiUsage', cliAuthMethod: 'api_key' }),
        });
        await live.refresh();
        expect(live.view()[own.id]?.check).toEqual({ state: 'mismatch', differences: ['method'] });
    });

    it('the default home\'s status belongs only to the default-home account with its email: never to another', async () => {
        const known = rec('account_legacy_claude', { identity: { name: null, email: 'person@example.test', plan: null } });
        const otherKnown = rec(`account_${'5'.repeat(32)}`, { identity: { name: null, email: 'someone@example.test', plan: null } });
        const live = new ClaudeAccountsLive({
            accounts: () => [known, otherKnown], defaultDir: () => null, recordIdentity: async () => {}, changed: () => {},
            describe: async () => status({ requestedConfigDir: null, configDirectory: '/home/.claude' }),
        });
        await live.refresh();
        expect(live.view()[known.id]?.signedIn).toBe(true);
        expect(live.view()[otherKnown.id]).toBeUndefined();
    });

    it('a describe that fails says nothing (no state), never a guess', async () => {
        const own = rec(`account_${'6'.repeat(32)}`, { configDir: '/d', method: 'console' });
        const live = new ClaudeAccountsLive({ accounts: () => [own], defaultDir: () => null, recordIdentity: async () => {}, changed: () => {}, describe: async () => { throw new Error('no CLI'); } });
        await live.refresh();
        expect(live.view()[own.id]).toBeUndefined();
    });

    /*
     * A REFRESH ASKED WHILE ONE IS UNDER WAY READS AGAIN AFTER IT (Tynn #1081, the claude-accounts row's check 23, failed in gates
     * 1125-084329-e9b61f and 1127-011906-956340 with the host saying "Team API is signed in."). The sign-in's end asks for a
     * refresh; one already under way (asked when the CLI asked for the code, or by a window listing the accounts) had described
     * the folder BEFORE the CLI wrote its sign-in. Handing back that run read "signed out", changed nothing, told no window, and
     * stamped the view fresh: nothing read the folder again until a window listed the accounts 20 s later.
     */
    it('a refresh asked while one is under way reads again after it: the sign-in that finished meanwhile is shown, and the windows told', async () => {
        const own = rec(`account_${'7'.repeat(32)}`, { configDir: '/team', method: 'console' });
        let signedIn = false;
        const held: { release: (() => void) | null } = { release: null };
        let changes = 0;
        const live = new ClaudeAccountsLive({
            accounts: () => [own], defaultDir: () => null, recordIdentity: async () => {}, changed: () => { changes += 1; },
            describe: async (dir) => {
                // What the CLI says is read at the START of the describe; the first one is then held open.
                const now = status({ requestedConfigDir: dir, configDirectory: dir ?? undefined, method: 'console', billing: 'apiUsage', cliAuthMethod: 'api_key', signedIn, ...(signedIn ? {} : { email: undefined }) });
                if (held.release === null) await new Promise<void>((r) => { held.release = r; });
                return now;
            },
        });
        const first = live.refresh();
        await Promise.resolve();
        // The sign-in finishes while the first describe is out, and asks for a refresh.
        signedIn = true;
        const second = live.refresh();
        held.release?.();
        await first;
        await second;
        expect(live.view()[own.id]?.signedIn).toBe(true);
        expect(changes).toBeGreaterThan(0);
    });

    it('CONTROL: refreshes asked together while one is under way read ONCE more, not once each', async () => {
        const own = rec(`account_${'8'.repeat(32)}`, { configDir: '/one', method: 'subscription' });
        let calls = 0;
        const held: { release: (() => void) | null } = { release: null };
        const live = new ClaudeAccountsLive({
            accounts: () => [own], defaultDir: () => null, recordIdentity: async () => {}, changed: () => {},
            describe: async (dir) => { calls += 1; if (calls === 1) await new Promise<void>((r) => { held.release = r; }); return status({ requestedConfigDir: dir, configDirectory: dir ?? undefined }); },
        });
        const first = live.refresh();
        await Promise.resolve();
        const asked = [live.refresh(), live.refresh(), live.refresh()];
        held.release?.();
        await Promise.all([first, ...asked]);
        expect(calls).toBe(2);
    });
});

describe('the default home\'s identity read never takes over a CHOSEN account with its own directory', () => {
    it('with an own-directory account active, nothing is read from the default home and nothing is recorded', async () => {
        const runs: string[] = [];
        const recorded: unknown[] = [];
        const book = {
            activeFor: () => ({ provider: 'claude' as const, configDir: '/genie/accounts/claude/x' }),
            recordSignedIn: async (_p: unknown, identity: unknown) => { recorded.push(identity); return null; },
        };
        const ports = (() => ({ run: async (binary: string) => { runs.push(binary); return { exitCode: 0, stdout: '{"loggedIn":true,"email":"other@example.test"}' }; } })) as never;
        await new AccountIdentityReader(book as never, ports).refreshProvider('claude');
        expect(runs).toEqual([]);
        expect(recorded).toEqual([]);
    });
});
