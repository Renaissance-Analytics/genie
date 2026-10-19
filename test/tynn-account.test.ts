import { describe, expect, it } from 'vitest';
import { TynnAccount, type TynnAccountPorts } from '../src/main/tynn-account.js';

/**
 * THIS GENIE'S TYNN ACCOUNT. The code from the browser is swapped once (POST /api/v1/genie/sign-in) for an account key
 * named for this computer; the key is kept ONLY through the secret store (Electron's safeStorage in the app) and never in
 * settings, and Sign out revokes it at Tynn before forgetting it. The network and the store are ports: no Tynn here.
 */

const CODE = 'aB3'.repeat(21) + 'x';
const KEY = 'aak_01JABCDEFGHJKMNPQRSTVWXYZ0.secret';

function fakes(answer: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => { status: number; body: string }) {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
    let stored: string | null = null;
    const writes: string[] = [];
    const ports: TynnAccountPorts = {
        fetch: async (url, init) => {
            calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}) });
            const a = answer(url, init);
            return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body };
        },
        store: {
            read: async () => stored,
            write: async (s) => { writes.push(s); stored = s; },
            clear: async () => { stored = null; },
        },
        host: () => 'https://tynn.ai',
        device: () => 'Office PC',
    };
    return { ports, calls, writes, stored: () => stored };
}

const signedIn = () => fakes((url) => url.endsWith('/sign-in')
    ? { status: 200, body: JSON.stringify({ token: KEY, user: { id: '7', name: 'Ada', email: 'ada@example.com' } }) }
    : { status: 204, body: '' });

describe('TynnAccount.signIn', () => {
    it('swaps the code at /api/v1/genie/sign-in, naming this computer, and keeps the key in the secret store', async () => {
        const f = signedIn();
        const account = await TynnAccount.open(f.ports);

        expect(await account.signIn(CODE)).toEqual({ ok: true, user: { name: 'Ada', email: 'ada@example.com' } });
        expect(f.calls).toEqual([{ url: 'https://tynn.ai/api/v1/genie/sign-in', method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: { code: CODE, device: 'Office PC' } }]);
        expect(account.status()).toEqual({ signedIn: true, host: 'https://tynn.ai', user: { name: 'Ada', email: 'ada@example.com' } });
        expect(account.token()).toBe(KEY);
        expect(f.writes).toHaveLength(1);
    });

    it('a pasted genie:// URL works as well as the bare code', async () => {
        const f = signedIn();
        const account = await TynnAccount.open(f.ports);
        expect((await account.signIn(`genie://oauth/callback?token=${CODE}`)).ok).toBe(true);
        expect(f.calls[0]?.body).toEqual({ code: CODE, device: 'Office PC' });
    });

    it('Tynn’s refusal is reported in its words and nothing is stored', async () => {
        const f = fakes(() => ({ status: 422, body: JSON.stringify({ message: 'That sign-in code is not valid.' }) }));
        const account = await TynnAccount.open(f.ports);
        expect(await account.signIn(CODE)).toEqual({ ok: false, reason: 'Tynn answered 422: That sign-in code is not valid.' });
        expect(account.status()).toEqual({ signedIn: false });
        expect(account.token()).toBe('');
        expect(f.writes).toEqual([]);
    });

    it('something that is not a code is refused before any request', async () => {
        const f = signedIn();
        const account = await TynnAccount.open(f.ports);
        expect((await account.signIn('my-password')).ok).toBe(false);
        expect(f.calls).toEqual([]);
    });

    it('a 200 without a key in it is not a sign-in', async () => {
        const f = fakes(() => ({ status: 200, body: '{"user":{"name":"Ada"}}' }));
        const account = await TynnAccount.open(f.ports);
        expect((await account.signIn(CODE)).ok).toBe(false);
        expect(f.writes).toEqual([]);
    });
});

describe('TynnAccount — a key that cannot be kept safely is not kept', () => {
    it('the secret store refusing (no OS encryption) fails the sign-in in words; nothing is held, nothing in the clear', async () => {
        const f = signedIn();
        f.ports.store.write = async () => { throw new Error('encryption is not available'); };
        const account = await TynnAccount.open(f.ports);
        const r = await account.signIn(CODE);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toMatch(/could not be kept safely on this machine \(encryption is not available\)/);
        expect(account.status()).toEqual({ signedIn: false });
        expect(account.token()).toBe('');
    });
});

describe('TynnAccount across launches', () => {
    it('a later launch reads the stored key back: still signed in, same person', async () => {
        const f = signedIn();
        await (await TynnAccount.open(f.ports)).signIn(CODE);
        const next = await TynnAccount.open(f.ports);
        expect(next.status()).toEqual({ signedIn: true, host: 'https://tynn.ai', user: { name: 'Ada', email: 'ada@example.com' } });
        expect(next.token()).toBe(KEY);
    });

    it('a key minted by another Tynn host is not sent to this one', async () => {
        const f = signedIn();
        await (await TynnAccount.open(f.ports)).signIn(CODE);
        const elsewhere = await TynnAccount.open({ ...f.ports, host: () => 'https://tynn.example.com' });
        expect(elsewhere.status()).toEqual({ signedIn: false });
        expect(elsewhere.token()).toBe('');
    });

    it('CONTROL: an unreadable store is signed out, not a crash', async () => {
        const f = signedIn();
        await f.ports.store.write('not json');
        const account = await TynnAccount.open(f.ports);
        expect(account.status()).toEqual({ signedIn: false });
    });
});

describe('TynnAccount.signOut', () => {
    it('revokes the key at Tynn with the key itself, then forgets it', async () => {
        const f = signedIn();
        const account = await TynnAccount.open(f.ports);
        await account.signIn(CODE);
        const changes: boolean[] = [];
        account.onChange(() => changes.push(account.status().signedIn));

        expect(await account.signOut()).toEqual({ ok: true, revoked: true });
        expect(f.calls[1]).toEqual({ url: 'https://tynn.ai/api/v1/genie/sign-out', method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${KEY}` } });
        expect(account.status()).toEqual({ signedIn: false });
        expect(f.stored()).toBeNull();
        expect(changes).toEqual([false]);
    });

    it('Tynn unreachable: this Genie still forgets the key, and says the key is still live at Tynn', async () => {
        const f = signedIn();
        const account = await TynnAccount.open(f.ports);
        await account.signIn(CODE);
        f.ports.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND tynn.ai'); };

        expect(await account.signOut()).toEqual({ ok: true, revoked: false, reason: 'Tynn could not be reached (getaddrinfo ENOTFOUND tynn.ai) — the key “Genie — Office PC” is still listed on Tynn under Account → Tokens; revoke it there.' });
        expect(f.stored()).toBeNull();
    });
});

describe('TynnAccount.projects', () => {
    it('lists the person’s projects with the key', async () => {
        const f = fakes((url) => url.endsWith('/sign-in')
            ? { status: 200, body: JSON.stringify({ token: KEY, user: { name: 'Ada', email: 'ada@example.com' } }) }
            : { status: 200, body: JSON.stringify({ data: [{ id: 42, name: 'Tynn.ai', slug: 'tynn', vision: 'PM.' }] }) });
        const account = await TynnAccount.open(f.ports);
        await account.signIn(CODE);
        expect(await account.projects()).toEqual([{ id: 42, name: 'Tynn.ai', slug: 'tynn', vision: 'PM.' }]);
        expect(f.calls[1]).toEqual({ url: 'https://tynn.ai/api/v1/genie/projects', method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${KEY}` } });
    });

    it('signed out is refused before any request', async () => {
        const f = signedIn();
        await expect((await TynnAccount.open(f.ports)).projects()).rejects.toThrow(/Sign in to Tynn first/);
        expect(f.calls).toEqual([]);
    });
});
