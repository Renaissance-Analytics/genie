import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountLabel, legacyAccountId } from '../src/core/accounts.js';
import { AccountsHost, type AccountsOptions } from '../src/main/accounts-host.js';
import { GENIE_SKILLS, skillFile } from '../src/main/agent-skills.js';
import { sharedProtocol, providerProtocol } from '../src/core/genie-protocol.js';
import { writeJsonAtomic } from '../src/main/store.js';

// The VM owns every file. No real provider home or credential is opened by these tests.
let dir: string;
let options: AccountsOptions;
let nextId: number;
const NOW = '2026-11-14T23:59:00.000Z';
const UNKNOWN = { name: null, email: null, plan: null };
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-accounts-474-'));
    nextId = 0;
    options = { root: join(dir, 'genie'), legacyHomes: { claude: join(dir, 'old-claude'), codex: join(dir, 'old-codex') },
        now: () => NOW, mintId: () => `account_${String(++nextId).padStart(32, '0')}` };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const file = () => join(options.root, 'runtime', 'accounts.json');
const reopen = () => AccountsHost.open(options);

describe('Accounts S1: a stable host book, no provider login material', () => {
    it('creates exactly two stable legacy defaults with explicitly unknown identity', async () => {
        const book = await reopen();
        expect(book.list()).toHaveLength(2);
        for (const provider of ['claude', 'codex'] as const) {
            expect(book.activeFor(provider)).toEqual({ id: `account_legacy_${provider}`, provider, label: 'Account 1', labelEdited: false,
                home: options.legacyHomes[provider], legacy: true, identity: UNKNOWN, createdAt: NOW });
            expect(legacyAccountId(provider)).toBe(`account_legacy_${provider}`);
        }
    });

    it('never opens or moves legacy-home files, including when a home is not readable', async () => {
        // A FILE rather than a directory: traversing it to read/copy settings would fail.
        for (const home of Object.values(options.legacyHomes)) await writeFile(home, 'provider-owned sentinel');
        const book = await reopen();
        expect(book.list()).toHaveLength(2);
        for (const home of Object.values(options.legacyHomes)) expect(await readFile(home, 'utf8')).toBe('provider-owned sentinel');
        expect(await readdir(options.root)).toEqual(['runtime']);
    });

    it('persists beside agents.json, and reopening never changes ids, defaults, homes or creation times', async () => {
        const book = await reopen();
        expect(book.list()).toHaveLength(2);
        const bytes = await readFile(file(), 'utf8');
        const again = await AccountsHost.open({ ...options, now: () => '2030-01-01T00:00:00.000Z', legacyHomes: { claude: '/new/claude', codex: '/new/codex' } });
        expect(again.list()).toEqual(book.list());
        expect(await readFile(file(), 'utf8')).toBe(bytes);
    });

    it('adds an isolated home under the one Genie root and provisions only the new account', async () => {
        const provision = vi.fn(async () => {});
        const book = await AccountsHost.open({ ...options, provision });
        const account = await book.add({ provider: 'claude' });
        expect(account.home).toBe(join(options.root, 'accounts', 'claude', account.id));
        expect(account).toMatchObject({ label: 'Account 2', legacy: false, identity: UNKNOWN, createdAt: NOW });
        expect(provision).toHaveBeenCalledExactlyOnceWith(account);
        expect((await reopen()).get(account.id)).toEqual(account);
        expect(book.activeFor('claude')?.legacy).toBe(true);
    });

    it('generates instructions, a Genie plugin and skills for a fresh Claude home without copying a provider store', async () => {
        const account = await (await reopen()).add({ provider: 'claude' });
        expect(account.home).toBe(join(options.root, 'accounts', 'claude', account.id));
        expect(await readFile(join(account.home, 'CLAUDE.md'), 'utf8')).toBe(`${sharedProtocol([])}\n\n${providerProtocol('claude')}\n`);
        expect(JSON.parse(await readFile(join(account.home, 'settings.json'), 'utf8'))).toEqual({});
        expect(JSON.parse(await readFile(join(account.home, 'genie', 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'genie-own' });
        for (const skill of GENIE_SKILLS) expect(await readFile(join(account.home, 'skills', skill.name, 'SKILL.md'), 'utf8')).toBe(skillFile(skill));
        expect((await readdir(account.home)).sort()).toEqual(['CLAUDE.md', 'genie', 'settings.json', 'skills']);
    });

    it('generates Codex file-mode settings and instructions without creating auth or copying history', async () => {
        const account = await (await reopen()).add({ provider: 'codex' });
        expect(account.home).toBe(join(options.root, 'accounts', 'codex', account.id));
        expect(await readFile(join(account.home, 'AGENTS.md'), 'utf8')).toBe(`${sharedProtocol([])}\n\n${providerProtocol('codex')}\n`);
        expect(await readFile(join(account.home, 'config.toml'), 'utf8')).toBe('cli_auth_credentials_store = "file"\n');
        expect((await readdir(account.home)).sort()).toEqual(['AGENTS.md', 'config.toml', 'genie', 'skills']);
    });

    it('keeps simultaneous additions, their distinct ids, and provider-local fallback labels', async () => {
        const book = await reopen();
        const added = await Promise.all([book.add({ provider: 'claude' }), book.add({ provider: 'claude' }), book.add({ provider: 'codex' })]);
        expect(new Set(added.map(a => a.id)).size).toBe(3);
        expect(added.map(a => a.label)).toEqual(['Account 2', 'Account 3', 'Account 2']);
        expect((await reopen()).list()).toHaveLength(5);
    });

    it('allows an edited label, and later status metadata never replaces it', async () => {
        const book = await reopen();
        const account = await book.add({ provider: 'claude', label: '  Work Max  ' });
        expect(account.label).toBe('Work Max');
        await book.rename(account.id, 'Personal');
        await book.recordIdentity(account.id, { name: null, email: 'someone@example.com', plan: null });
        expect((await reopen()).get(account.id)).toMatchObject({ label: 'Personal', labelEdited: true, identity: { name: null, email: 'someone@example.com', plan: null } });
    });

    it('uses only explicitly reported email to prefill an untouched fallback label, keeping unknown fields null', async () => {
        const book = await reopen();
        const account = await book.add({ provider: 'codex' });
        await book.recordIdentity(account.id, { name: null, email: 'someone@example.com', plan: null });
        expect(book.get(account.id)).toMatchObject({ label: 'someone@example.com', labelEdited: false, identity: { name: null, email: 'someone@example.com', plan: null } });
        expect(accountLabel(null, 2)).toBe('Account 2');
        expect(accountLabel('someone@example.com', 2)).toBe('someone@example.com');
    });

    it('returns detached views, so caller mutations cannot alter the durable book', async () => {
        const book = await reopen();
        expect(book.list()).toHaveLength(2);
        const account = book.list()[0]!;
        try { (account as { label: string }).label = 'changed'; } catch { /* frozen is also fine */ }
        try { (account.identity as { email: string | null }).email = 'fake@example.com'; } catch { /* frozen is also fine */ }
        expect(book.get(account.id)).toMatchObject({ label: 'Account 1', identity: UNKNOWN });
    });

    it('refuses a malformed book rather than overwriting it with a first-run default', async () => {
        await mkdir(dirname(file()), { recursive: true });
        await writeFile(file(), '{broken');
        await expect(reopen()).rejects.toThrow(/not valid|invalid/i);
        expect(await readFile(file(), 'utf8')).toBe('{broken');
    });

    it('refuses a syntactically valid book with an unsupported provider or escaped managed home', async () => {
        await mkdir(dirname(file()), { recursive: true });
        const bad = { version: 1, accounts: [{ id: 'account_bad', provider: 'other', label: 'bad', labelEdited: false, legacy: false, home: dir, identity: UNKNOWN, createdAt: NOW }] };
        await writeFile(file(), JSON.stringify(bad));
        await expect(reopen()).rejects.toThrow(/invalid|provider|account/i);
        bad.accounts[0]!.provider = 'claude';
        await writeFile(file(), JSON.stringify(bad));
        await expect(reopen()).rejects.toThrow(/invalid|home|account/i);
    });

    it('refuses id traversal and an occupied home without modifying its files', async () => {
        const bad = await AccountsHost.open({ ...options, mintId: () => '../../outside' });
        await expect(bad.add({ provider: 'claude' })).rejects.toThrow(/id|account/i);
        const id = `account_${'0'.repeat(31)}1`;
        const occupied = join(options.root, 'accounts', 'claude', id);
        await mkdir(occupied, { recursive: true });
        await writeFile(join(occupied, 'sentinel'), 'leave alone');
        const book = await reopen();
        await expect(book.add({ provider: 'claude' })).rejects.toThrow(/exist|occupied/i);
        expect(await readFile(join(occupied, 'sentinel'), 'utf8')).toBe('leave alone');
    });

    it('refuses a redirected account directory before generating files outside Genie root', async () => {
        const book = await reopen();
        expect(book.list()).toHaveLength(2);
        const outside = join(dir, 'outside');
        await mkdir(outside);
        await symlink(outside, join(options.root, 'accounts'), process.platform === 'win32' ? 'junction' : 'dir');
        await expect(book.add({ provider: 'claude' })).rejects.toThrow(/link|redirect|directory/i);
        expect(await readdir(outside)).toEqual([]);
    });

    it('does not publish an account when provisioning fails, and does not delete provider files', async () => {
        const provision = vi.fn(async () => { throw new Error('fixture provision refused'); });
        const book = await AccountsHost.open({ ...options, provision });
        await expect(book.add({ provider: 'claude' })).rejects.toThrow('fixture provision refused');
        expect((await reopen()).list()).toHaveLength(2);
    });

    it('refuses blank labels and unknown account mutations without changing the book', async () => {
        const book = await reopen();
        await expect(book.add({ provider: 'claude', label: '  ' })).rejects.toThrow(/label/i);
        await expect(book.rename('missing', 'Work')).rejects.toThrow(/unknown|account/i);
        await expect(book.recordIdentity('missing', UNKNOWN)).rejects.toThrow(/unknown|account/i);
    });

    it('opens the account owner in genie-host after secret refusal and before SessionHost admission', async () => {
        const source = await readFile(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8');
        const open = source.indexOf('await AccountsHost.open(');
        expect(open).toBeGreaterThan(source.indexOf('await openSecretKeychain('));
        expect(open).toBeLessThan(source.indexOf('const host = new ' + 'SessionHost('));
        expect(source).toContain("from './accounts-host.js'");
    });

    it('CONTROL: the existing atomic writer preserves one whole JSON value for concurrent writes', async () => {
        const at = join(dir, 'control.json');
        await Promise.all([writeJsonAtomic(at, { value: 'first' }), writeJsonAtomic(at, { value: 'last' })]);
        expect(JSON.parse(await readFile(at, 'utf8'))).toEqual({ value: 'last' });
    });

    it('CONTROL: the canonical skill bytes contain only generated Genie instructions', () => {
        expect(GENIE_SKILLS.length).toBeGreaterThan(0);
        for (const skill of GENIE_SKILLS) expect(skillFile(skill)).toContain(`name: ${skill.name}`);
    });
});
