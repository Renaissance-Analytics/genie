import { describe, expect, it } from 'vitest';
import { chmod, mkdir, readFile, rename, stat, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TynnAccount, type TynnAccountPorts } from '../src/main/tynn-account.js';

import { fakeTynnStorage, PAIRING_SCOPES, PAIRING_TOKEN } from './helpers/tynn-storage.js';

/** Existing account behavior, now over a durable scoped bearer. Cookies are exchange-only. */
const HOST = 'https://tynn.example';
const CODE = 'aB3'.repeat(21) + 'x';
const USER = { id: '7', name: 'Ada', email: 'ada@example.com' };

function fakeTynn(opts: { reachable?: boolean; authFail?: 401 | 404 } = {}) {
    const jar = new Map<string, string>();
    const calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
    let codeValid = true;
    let sessionLive = false;
    // What Tynn answers a request it cannot authenticate: 401, or 404 since the owner's rule of 2026-10-19 (a failed auth
    // is indistinguishable from a path that does not exist).
    const state = { reachable: opts.reachable ?? true, authFail: opts.authFail ?? 401 };
    const ports: TynnAccountPorts = {
        ...fakeTynnStorage(),
        host: () => HOST,
        cookies: {
            set: async (host, name, value) => { expect(host).toBe(HOST); jar.set(name, value); },
            get: async (host, name) => { expect(host).toBe(HOST); return jar.get(name) ?? null; },
            clear: async (host) => { expect(host).toBe(HOST); jar.clear(); },
        },
        fetch: async (url, init) => {
            if (!state.reachable) throw new Error('getaddrinfo ENOTFOUND tynn.example');
            const path = url.slice(HOST.length);
            calls.push({ method: init.method, path, headers: init.headers, ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}) });
            const ok = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
            const bearer = init.headers.Authorization === `Bearer ${PAIRING_TOKEN}` && sessionLive;
            if (path === '/api/v1/me') {
                if (init.credentials === 'include' && !sessionLive && jar.get('genie_token') === CODE && codeValid) {
                    codeValid = false; sessionLive = true;
                    jar.set('laravel_session', 'sess'); jar.set('XSRF-TOKEN', 'xsrf%3Dvalue');
                    return ok(200, { ...USER, pairing_token: PAIRING_TOKEN, pairing_scopes: PAIRING_SCOPES });
                }
                return bearer ? ok(200, USER) : ok(state.authFail, { error: 'unauthenticated' });
            }
            if (!bearer || init.credentials !== 'omit') return ok(state.authFail, { message: 'Unauthenticated.' });
            if (path === '/api/v1/pairing-token' && init.method === 'DELETE') { sessionLive = false; return ok(200, { revoked: true }); }
            if (path === '/api/v1/projects') return ok(200, { data: [{ id: '42', name: 'Tynn.ai', slug: 'tynn' }] });
            if (path === '/api/v1/user/issue-watch/refresh') return ok(200, { refreshed: true });
            return ok(404, { message: 'Not Found' });
        },
    };
    return { ports, jar, calls, state, endSession: () => { sessionLive = false; }, reviveSession: () => { sessionLive = true; } };
}

describe.skipIf(process.platform === 'win32')('Tynn account credential permissions', () => {
    it('restricts an existing permissive directory before any account exchange', async () => {
        const t = fakeTynn(); await chmod(dirname(t.ports.file), 0o755);
        await TynnAccount.open(t.ports);
        expect((await stat(dirname(t.ports.file))).mode & 0o777).toBe(0o700);
        expect(t.calls).toHaveLength(0);
    });

    it('restricts an existing credential file before restoring its bearer', async () => {
        const t = fakeTynn(); await (await TynnAccount.open(t.ports)).signIn(CODE);
        await chmod(t.ports.file, 0o644);
        expect((await TynnAccount.open(t.ports)).status().signedIn).toBe(true);
        expect((await stat(t.ports.file)).mode & 0o777).toBe(0o600);
    });

    it('refuses a symlinked credential file before restoring or sending its bearer', async () => {
        const t = fakeTynn(); await (await TynnAccount.open(t.ports)).signIn(CODE);
        const before = t.calls.length; await rename(t.ports.file, `${t.ports.file}.original`);
        await symlink(`${t.ports.file}.original`, t.ports.file);
        expect((await TynnAccount.open(t.ports)).status().signedIn).toBe(false);
        expect(t.calls).toHaveLength(before);
    });

    it('refuses a symlinked credential directory before exchanging the sign-in code', async () => {
        const t = fakeTynn(); const root = dirname(t.ports.file);
        const target = join(root, 'real'); const link = join(root, 'alias');
        await mkdir(target); await symlink(target, link);
        const account = await TynnAccount.open({ ...t.ports, file: join(link, 'tynn.json') });
        expect((await account.signIn(CODE)).ok).toBe(false);
        expect(t.calls).toHaveLength(0);
    });
});

describe('TynnAccount.signIn — Genie 1’s redeemToken', () => {
    it('drops the code as genie_token on the Tynn origin and asks /api/v1/me, which returns the scoped pairing credential', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        expect(account.status()).toEqual({ signedIn: false });

        expect(await account.signIn(CODE)).toEqual({ ok: true, user: { name: 'Ada', email: 'ada@example.com' } });
        expect(account.status()).toEqual({ signedIn: true, host: HOST, user: { name: 'Ada', email: 'ada@example.com' } });
        expect(t.jar.size).toBe(0);
        // No saved credential: launch makes no authenticated probe. Only the exchange reaches /me.
        expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/me']);
    });

    it('a pasted genie:// URL works as well as the bare code', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        expect((await account.signIn(`genie://oauth/callback?token=${CODE}`)).ok).toBe(true);
    });

    it('a code Tynn does not take (spent, expired) says so; signed out, and the dead code is not left in the jar', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        expect((await account.signIn(CODE)).ok).toBe(true);
        await account.signOut();
        const again = await account.signIn(CODE);
        expect(again).toEqual({ ok: false, reason: 'That code was already used. Open Tynn again for a fresh sign-in code.' });
        expect(account.status()).toEqual({ signedIn: false });
        expect(t.jar.has('genie_token')).toBe(false);
    });

    it('something that is not a code is refused before any request', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        const before = t.calls.length;
        expect((await account.signIn('my-password')).ok).toBe(false);
        expect(t.calls.length).toBe(before);
    });

    it('Tynn unreachable: said in words, nothing pretends', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        t.state.reachable = false;
        expect(await account.signIn(CODE)).toEqual({ ok: false, reason: 'Tynn pairing could not be completed. Check your connection and OS keychain, then try again.' });
        expect(account.status()).toEqual({ signedIn: false });
    });
});

describe('TynnAccount across launches', () => {
    it('a later launch restores the encrypted bearer and verifies it at /api/v1/me', async () => {
        const t = fakeTynn();
        await (await TynnAccount.open(t.ports)).signIn(CODE);
        const next = await TynnAccount.open(t.ports);
        expect(next.status()).toEqual({ signedIn: true, host: HOST, user: { name: 'Ada', email: 'ada@example.com' } });
    });

    it('CONTROL: a session Tynn ended (expired, signed out elsewhere) opens signed out', async () => {
        const t = fakeTynn();
        await (await TynnAccount.open(t.ports)).signIn(CODE);
        t.endSession();
        expect((await TynnAccount.open(t.ports)).status()).toEqual({ signedIn: false });
    });

    it('Tynn unreachable at launch: signed out for now, while the encrypted credential is kept for recheck', async () => {
        const t = fakeTynn();
        await (await TynnAccount.open(t.ports)).signIn(CODE);
        t.state.reachable = false;
        const offline = await TynnAccount.open(t.ports);
        expect(offline.status()).toEqual({ signedIn: false });
        expect(t.jar.size).toBe(0);
        t.state.reachable = true;
        expect(await offline.recheck()).toEqual({ signedIn: true, host: HOST, user: { name: 'Ada', email: 'ada@example.com' } });
    });
});

describe('TynnAccount.signOut', () => {
    it('revokes the scoped bearer at Tynn, then stays durably signed out', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        const changes: boolean[] = [];
        account.onChange(() => changes.push(account.status().signedIn));

        expect(await account.signOut()).toEqual({ ok: true, revoked: true });
        expect(t.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/v1/pairing-token', headers: { Authorization: `Bearer ${PAIRING_TOKEN}`, 'X-Requested-With': 'XMLHttpRequest' } });
        expect(t.jar.size).toBe(0);
        expect(account.status()).toEqual({ signedIn: false });
        expect(changes).toEqual([false]);
    });

    it('Tynn unreachable: local sign-out is durable and remote revocation is reported unconfirmed', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        t.state.reachable = false;
        expect(await account.signOut()).toEqual({ ok: true, revoked: false, reason: 'This Genie is signed out. Tynn credential revocation could not be confirmed; revoke this device in Tynn if it remains listed.' });
        expect(t.jar.size).toBe(0);
    });
});

describe('TynnAccount.request — every call uses the scoped bearer', () => {
    it('a write carries the scoped bearer and JSON body; a read carries no content type', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        const res = await account.request('/api/v1/user/issue-watch/refresh', { method: 'POST', body: { project_id: 'p1' } });
        expect(res.status).toBe(200);
        expect(t.calls.at(-1)).toEqual({ method: 'POST', path: '/api/v1/user/issue-watch/refresh', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json', Authorization: `Bearer ${PAIRING_TOKEN}` }, body: { project_id: 'p1' } });
        await account.request('/api/v1/projects', { method: 'GET' });
        expect(t.calls.at(-1)!.headers).toEqual({ Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Authorization: `Bearer ${PAIRING_TOKEN}` });
    });

    // Tynn #839: revoking a share link is a DELETE (Genie 1's revokeWorkspaceShareLink) — a write, so it carries the token.
    it('a DELETE uses the scoped bearer without a browser CSRF cookie', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        await account.request('/api/v1/workstations/ws_1/share-links/inv_1', { method: 'DELETE' });
        expect(t.calls.find((c) => c.method === 'DELETE')).toMatchObject({ path: '/api/v1/workstations/ws_1/share-links/inv_1', headers: { Authorization: `Bearer ${PAIRING_TOKEN}` } });
    });

    it('Tynn answering 401 means the session is gone: this Genie shows signed out', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        const changes: boolean[] = [];
        account.onChange(() => changes.push(account.status().signedIn));
        t.endSession();
        expect((await account.request('/api/v1/projects', { method: 'GET' })).status).toBe(401);
        expect(account.status()).toEqual({ signedIn: false });
        expect(changes).toEqual([false]);
    });

    /*
     * A 404 FROM /me IS "NOT AUTHORIZED" — AND MAYBE A DEPLOY (genie#1234; the owner on PR #1236). Tynn answers EVERY
     * unauthorized request with 404 by design, so bots get nothing but 400/404, and that will not change. A deploy or a
     * routing fault answers 404 too, and nothing tells the two apart. So a 404 shows SIGNED OUT now, KEEPS the saved
     * credential, and asks again on the backoff: a passing 404 heals itself with no new sign-in; a real revocation stays
     * signed out until the person pairs again, and the new pairing replaces the credential.
     */
    function retries() {
        const timers: Array<{ ms: number; fn: () => void; live: boolean }> = [];
        return {
            timers,
            schedule: (ms: number, fn: () => void) => { const x = { ms, fn, live: true }; timers.push(x); return () => { x.live = false; }; },
            async fire() { const x = timers.find((y) => y.live); if (!x) return false; x.live = false; x.fn(); for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); return true; },
        };
    }

    it('a 404 at /me after a 404 elsewhere: signed out NOW, the credential kept, a re-check scheduled (genie#1234)', async () => {
        const t = fakeTynn({ authFail: 404 }); const s = retries();
        const account = await TynnAccount.open({ ...t.ports, schedule: s.schedule });
        await account.signIn(CODE);
        const changes: boolean[] = [];
        account.onChange(() => changes.push(account.status().signedIn));
        t.endSession();
        expect((await account.request('/api/v1/projects', { method: 'GET' })).status).toBe(404);
        expect(t.calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/v1/me' });
        expect(account.status(), 'the UI shows signed out').toEqual({ signedIn: false });
        expect(changes).toEqual([false]);
        expect(account.savedUserId(), 'the credential is kept').toBe('7');
        expect(JSON.parse(await readFile(t.ports.file, 'utf8')), 'and kept on disk').toMatchObject({ state: 'signed-in', tokenEnc: expect.any(String) });
        expect(s.timers.filter((x) => x.live).map((x) => x.ms), 'the backoff re-check is scheduled').toEqual([30_000]);
    });

    it('then Tynn answers 200 for the same account: signed in again by the re-check, with no new pairing (genie#1234)', async () => {
        const t = fakeTynn({ authFail: 404 }); const s = retries();
        const account = await TynnAccount.open({ ...t.ports, schedule: s.schedule });
        await account.signIn(CODE);
        t.endSession();
        await account.request('/api/v1/projects', { method: 'GET' });
        const changes: boolean[] = [];
        account.onChange(() => changes.push(account.status().signedIn));
        t.reviveSession();
        expect(await s.fire()).toBe(true);
        expect(account.status()).toMatchObject({ signedIn: true, user: { name: 'Ada' } });
        expect(changes, 'announced, so agents without Tynn recover').toEqual([true]);
        expect(t.calls.filter((c) => c.headers.Authorization === undefined), 'no new pairing exchange').toHaveLength(1);
        expect((await TynnAccount.open(t.ports)).status().signedIn, 'and the next launch restores it').toBe(true);
    });

    it('a 404 at /me that stays: the backoff still stops after its four tries, never a poll (genie#1234)', async () => {
        const t = fakeTynn({ authFail: 404 }); const s = retries();
        const account = await TynnAccount.open({ ...t.ports, schedule: s.schedule });
        await account.signIn(CODE);
        t.endSession();
        await account.request('/api/v1/projects', { method: 'GET' });
        let fired = 0; while (await s.fire()) { if (++fired > 10) break; }
        expect(s.timers.map((x) => x.ms)).toEqual([30_000, 120_000, 600_000, 1_800_000]);
        expect(account.savedUserId()).toBe('7');
    });

    it('CONTROL: a 200 path leaves the account alone — signed in, no /me, nothing scheduled', async () => {
        const t = fakeTynn({ authFail: 404 }); const s = retries();
        const account = await TynnAccount.open({ ...t.ports, schedule: s.schedule });
        await account.signIn(CODE);
        const changes: boolean[] = [];
        account.onChange(() => changes.push(account.status().signedIn));
        expect((await account.request('/api/v1/projects', { method: 'GET' })).status).toBe(200);
        expect(t.calls.at(-1)).toMatchObject({ path: '/api/v1/projects' });
        expect(account.status().signedIn).toBe(true);
        expect(changes).toEqual([]); expect(s.timers).toEqual([]);
    });

    it.each([404, 500, 503])('a %s from /me at launch keeps the saved credential (genie#1234)', async (status) => {
        const t = fakeTynn();
        await (await TynnAccount.open(t.ports)).signIn(CODE);
        const answer = t.ports.fetch;
        const flaky = await TynnAccount.open({ ...t.ports, fetch: async (url, init) => url.endsWith('/api/v1/me') ? { ok: false, status, text: async () => '{}' } : answer(url, init) });
        expect(flaky.status().signedIn, 'not confirmed this time').toBe(false);
        expect((await TynnAccount.open(t.ports)).status().signedIn, 'the next answer from Tynn signs in').toBe(true);
    });

    it.each([401, 419])('CONTROL: a %s from /me is a definite revocation and clears the credential', async (status) => {
        const t = fakeTynn();
        await (await TynnAccount.open(t.ports)).signIn(CODE);
        const answer = t.ports.fetch;
        await TynnAccount.open({ ...t.ports, fetch: async (url, init) => url.endsWith('/api/v1/me') ? { ok: false, status, text: async () => '{}' } : answer(url, init) });
        expect((await TynnAccount.open(t.ports)).status().signedIn).toBe(false);
    });

    it('CONTROL: a 404 for a path that is not there, with the session live, leaves this Genie signed in', async () => {
        const t = fakeTynn({ authFail: 404 });
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        const changes: boolean[] = [];
        account.onChange(() => changes.push(account.status().signedIn));
        expect((await account.request('/api/v1/nothing-here', { method: 'GET' })).status).toBe(404);
        expect(account.status().signedIn).toBe(true);
        expect(changes).toEqual([]);
    });

    it('the person’s id for their own push channel — only while signed in', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        expect(account.userId()).toBeNull();
        await account.signIn(CODE);
        expect(account.userId()).toBe('7');
    });

    it('the saved account id is known before Tynn confirms it, so a stored agent key works off grid (genie#1234)', async () => {
        const t = fakeTynn();
        expect((await TynnAccount.open(t.ports)).savedUserId()).toBeNull();
        await (await TynnAccount.open(t.ports)).signIn(CODE);
        t.state.reachable = false;
        const offline = await TynnAccount.open(t.ports);
        expect(offline.userId(), 'not confirmed: no live identity').toBeNull();
        expect(offline.savedUserId()).toBe('7');
        await offline.signOut();
        expect(offline.savedUserId(), 'signing out forgets it').toBeNull();
    });
});

describe('TynnAccount.projects — Genie 1’s GET /api/v1/projects', () => {
    it('lists the person’s projects over the session', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        expect(await account.projects()).toEqual([{ id: '42', name: 'Tynn.ai', slug: 'tynn' }]);
        expect(t.calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/v1/projects' });
    });

    it('signed out is refused before any request', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        const before = t.calls.length;
        await expect(account.projects()).rejects.toThrow(/Sign in to Tynn first/);
        expect(t.calls.length).toBe(before);
    });
});

/**
 * UNREACHABLE AT LAUNCH IS NOT SIGNED OUT FOR GOOD (the owner, 2026-10-21: an issue was filed and no agent was told).
 * MEASURED: Genie checks the session once at launch; if Tynn cannot be reached then, it shows signed out and keeps the
 * cookies "for recheck" — and nothing ever called `recheck`, so IssueWatch stayed signed-out until a fresh sign-in.
 * Now an unreachable check is retried on a short backoff (30 s, 2 min, 10 min, 30 min — then it stops: no poll), and a
 * Tynn that ANSWERS "not you" is final and never retried.
 */
describe('TynnAccount — a launch with Tynn unreachable', () => {
    function scheduler() {
        const timers: Array<{ ms: number; fn: () => void; live: boolean }> = [];
        return {
            timers,
            schedule: (ms: number, fn: () => void) => { const t = { ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
            /** Run the oldest live timer, as time passing would. */
            async fire() { const t = timers.find((x) => x.live); if (!t) return false; t.live = false; t.fn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); return true; },
        };
    }
    async function signedInSession() {
        const t = fakeTynn();
        const first = await TynnAccount.open(t.ports);
        expect((await first.signIn(CODE)).ok).toBe(true);
        return t;
    }

    it('retries once Tynn answers again: signed in, and the change is announced (IssueWatch restarts on it)', async () => {
        const t = await signedInSession();
        t.state.reachable = false;
        const s = scheduler();
        const account = await TynnAccount.open({ ...t.ports, schedule: s.schedule });
        expect(account.status().signedIn).toBe(false);
        expect(s.timers.map((x) => x.ms)).toEqual([30_000]);
        let changed = 0;
        account.onChange(() => { changed += 1; });
        t.state.reachable = true;
        await s.fire();
        expect(account.status()).toMatchObject({ signedIn: true, user: { name: 'Ada' } });
        expect(changed).toBe(1);
    });

    it('backs off 30 s, 2 min, 10 min, 30 min while still unreachable — then stops (COUNTED: four tries, no poll)', async () => {
        const t = await signedInSession();
        t.state.reachable = false;
        const s = scheduler();
        await TynnAccount.open({ ...t.ports, schedule: s.schedule });
        while (await s.fire()) { /* time passes */ }
        expect(s.timers.map((x) => x.ms)).toEqual([30_000, 120_000, 600_000, 1_800_000]);
    });

    it('CONTROL: Tynn answered "not you" — signed out, and nothing is scheduled', async () => {
        const t = fakeTynn();
        const s = scheduler();
        const account = await TynnAccount.open({ ...t.ports, schedule: s.schedule });
        expect(account.status().signedIn).toBe(false);
        expect(s.timers).toEqual([]);
    });

    it('an asked-for recheck (waking from sleep, an agent asking IssueWatch) signs in at once and drops the pending retry', async () => {
        const t = await signedInSession();
        t.state.reachable = false;
        const s = scheduler();
        const account = await TynnAccount.open({ ...t.ports, schedule: s.schedule });
        t.state.reachable = true;
        expect((await account.recheck()).signedIn).toBe(true);
        expect(s.timers.filter((x) => x.live)).toEqual([]);
    });
});
