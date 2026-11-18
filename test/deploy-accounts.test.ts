import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cloudAccountBook, type CloudAccountInput } from '../src/main/deploy-accounts.js';
import type { KeychainRead, KeychainResult, SecretName } from '../src/main/keychain.js';

/**
 * DEPLOYMENT D0-1 (Tynn #871; spec §3, decision D2). Cloud accounts: several per provider at once, each a billing
 * boundary. The token goes ONLY to the OS keychain (src/main/keychain.ts) as `deploy/<accountId>`; the account file holds
 * who the account is and what it may do, never the token. With no keychain, connecting is refused and nothing is written.
 */

const TOKEN = `dop_v1_${'5eed'.repeat(16)}`;
const dirs: string[] = [];
const freshDir = () => { const d = mkdtempSync(join(tmpdir(), 'deploy-accounts-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeKeychain(available = true) {
    const store = new Map<string, string>();
    const unavailable = { kind: 'unavailable', reason: 'no keyring answered' } as const;
    return {
        store,
        keychain: {
            get: async (name: SecretName): Promise<KeychainRead> => (!available ? unavailable : store.has(name) ? { kind: 'value', value: store.get(name)! } : { kind: 'missing' }),
            set: async (name: SecretName, value: string): Promise<KeychainResult> => { if (!available) return { ok: false, reason: 'no keyring answered' }; store.set(name, value); return { ok: true }; },
            delete: async (name: SecretName): Promise<KeychainResult> => { if (!available) return { ok: false, reason: 'no keyring answered' }; store.delete(name); return { ok: true }; },
        },
    };
}

const account = (over: Partial<CloudAccountInput> = {}): CloudAccountInput => ({
    id: 'acc-do-1',
    provider: 'digitalocean',
    label: 'Throwaway DO',
    identity: { id: 'team-123', name: 'Test team' },
    authKind: 'token',
    scopes: ['app:read', 'billing:read'],
    expiresAt: '2027-01-01T00:00:00Z',
    ...over,
});

function allFileText(dir: string): string {
    return readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

describe('connecting a cloud account', () => {
    it('keeps the token in the keychain as deploy/<id>, and the account file never holds it', async () => {
        const dir = freshDir();
        const { keychain, store } = fakeKeychain();
        const book = cloudAccountBook(join(dir, 'cloud-accounts.json'), keychain);
        expect(await book.connect(account(), TOKEN)).toEqual({ ok: true });
        expect(store.get('deploy/acc-do-1')).toBe(TOKEN);
        const text = allFileText(dir);
        expect(text).toContain('acc-do-1'); // positive control: the file was written and is what we searched
        expect(text).not.toContain(TOKEN);
        expect(await book.tokenFor('acc-do-1')).toEqual({ kind: 'value', value: TOKEN });
    });

    it('a field smuggled onto the account record (a token in an extra key) is not written', async () => {
        const dir = freshDir();
        const book = cloudAccountBook(join(dir, 'cloud-accounts.json'), fakeKeychain().keychain);
        await book.connect({ ...account(), token: TOKEN } as CloudAccountInput, TOKEN);
        expect(allFileText(dir)).not.toContain(TOKEN);
    });

    it('with no keychain, connecting is refused in words and nothing is written', async () => {
        const dir = freshDir();
        const file = join(dir, 'cloud-accounts.json');
        const book = cloudAccountBook(file, fakeKeychain(false).keychain);
        const result = await book.connect(account(), TOKEN);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/keyring|keychain/i);
        expect(existsSync(file)).toBe(false);
        expect(book.list()).toEqual([]);
    });

    it('several accounts of one provider live side by side (D2)', async () => {
        const dir = freshDir();
        const { keychain, store } = fakeKeychain();
        const book = cloudAccountBook(join(dir, 'cloud-accounts.json'), keychain);
        await book.connect(account(), TOKEN);
        await book.connect(account({ id: 'acc-do-2', label: 'Client DO' }), `${TOKEN}2`);
        expect(book.list().map((a) => a.id).sort()).toEqual(['acc-do-1', 'acc-do-2']);
        expect(store.get('deploy/acc-do-2')).toBe(`${TOKEN}2`);
    });

    it('an account signed in through the provider\'s own login stores no token at all', async () => {
        const dir = freshDir();
        const { keychain, store } = fakeKeychain();
        const book = cloudAccountBook(join(dir, 'cloud-accounts.json'), keychain);
        expect(await book.connect(account({ id: 'acc-aws-1', provider: 'aws', authKind: 'provider-login' }))).toEqual({ ok: true });
        expect(store.size).toBe(0);
        expect(book.list()[0].authKind).toBe('provider-login');
    });

    it('a stored account survives a restart (a new book on the same file)', async () => {
        const dir = freshDir();
        const { keychain } = fakeKeychain();
        const file = join(dir, 'cloud-accounts.json');
        await cloudAccountBook(file, keychain).connect(account(), TOKEN);
        const again = cloudAccountBook(file, keychain);
        expect(again.list()).toEqual([expect.objectContaining({ id: 'acc-do-1', provider: 'digitalocean', label: 'Throwaway DO', status: 'ok' })]);
        expect(await again.tokenFor('acc-do-1')).toEqual({ kind: 'value', value: TOKEN });
    });
});

describe('removing and re-signing', () => {
    it('removing an account deletes its keychain entry and its row', async () => {
        const dir = freshDir();
        const { keychain, store } = fakeKeychain();
        const book = cloudAccountBook(join(dir, 'cloud-accounts.json'), keychain);
        await book.connect(account(), TOKEN);
        expect(store.has('deploy/acc-do-1')).toBe(true);
        expect(await book.remove('acc-do-1')).toEqual({ ok: true });
        expect(store.has('deploy/acc-do-1')).toBe(false);
        expect(book.list()).toEqual([]);
    });

    it('a locked keychain on remove keeps the row: the secret is still there', async () => {
        const dir = freshDir();
        const file = join(dir, 'cloud-accounts.json');
        await cloudAccountBook(file, fakeKeychain().keychain).connect(account(), TOKEN);
        const locked = cloudAccountBook(file, fakeKeychain(false).keychain);
        expect((await locked.remove('acc-do-1')).ok).toBe(false);
        expect(locked.list().map((a) => a.id)).toEqual(['acc-do-1']);
    });

    it('a 401/403 marks the account "sign in again", never removes it', async () => {
        const dir = freshDir();
        const book = cloudAccountBook(join(dir, 'cloud-accounts.json'), fakeKeychain().keychain);
        await book.connect(account(), TOKEN);
        book.markSignInAgain('acc-do-1');
        expect(book.list()).toEqual([expect.objectContaining({ id: 'acc-do-1', status: 'sign-in-again' })]);
    });
});
