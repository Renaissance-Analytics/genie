import { describe, expect, it } from 'vitest';
import { TynnAccount, type TynnAccountPorts } from '../src/main/tynn-account.js';

/**
 * THIS GENIE'S TYNN ACCOUNT — GENIE 1'S SESSION, AS IT WAS (the owner, 2026-10-19: "tynn already had this half.
 * everything was already working in genie 1").
 *
 * Genie 1's `redeemToken`: the single-use code from /genie/callback is dropped as a `genie_token` cookie on the Tynn
 * origin, then `GET /api/v1/me` swaps it for a real Tynn session (Tynn's GenieAuthController::exchange). From then on
 * every call rides that session's cookies; a write carries the `X-XSRF-TOKEN` Laravel checks. Sign out ends the session
 * at Tynn (`POST /logout`) and clears the cookies. Nothing new on Tynn's side, and no key of Genie's own anywhere.
 *
 * The cookie jar and the session-bound fetch are ports (Electron's persistent `persist:tynn` session in the app); here a
 * fake Tynn that behaves like the real one: the code works once, the session is a cookie, /logout needs the XSRF token.
 */

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
            if (path === '/api/v1/me') {
                // Tynn's exchange: a valid genie_token becomes the session (laravel_session + XSRF-TOKEN cookies), once.
                if (!sessionLive && jar.get('genie_token') === CODE && codeValid) { codeValid = false; sessionLive = true; jar.set('laravel_session', 'sess'); jar.set('XSRF-TOKEN', 'xsrf%3Dvalue'); }
                return sessionLive && jar.get('laravel_session') === 'sess' ? ok(200, USER) : ok(state.authFail, { error: 'unauthenticated' });
            }
            if (!sessionLive || jar.get('laravel_session') !== 'sess') return ok(state.authFail, { message: 'Unauthenticated.' });
            if (init.method !== 'GET' && init.headers['X-XSRF-TOKEN'] !== 'xsrf=value') return ok(419, { message: 'CSRF token mismatch.' });
            if (path === '/logout') { sessionLive = false; return ok(204, undefined); }
            if (path === '/api/v1/projects') return ok(200, { data: [{ id: '42', name: 'Tynn.ai', slug: 'tynn' }] });
            if (path === '/api/v1/user/issue-watch/refresh') return ok(200, { refreshed: true });
            return ok(404, { message: 'Not Found' });
        },
    };
    return { ports, jar, calls, state, endSession: () => { sessionLive = false; } };
}

describe('TynnAccount.signIn — Genie 1’s redeemToken', () => {
    it('drops the code as genie_token on the Tynn origin and asks /api/v1/me, which swaps it for a session', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        expect(account.status()).toEqual({ signedIn: false });

        expect(await account.signIn(CODE)).toEqual({ ok: true, user: { name: 'Ada', email: 'ada@example.com' } });
        expect(account.status()).toEqual({ signedIn: true, host: HOST, user: { name: 'Ada', email: 'ada@example.com' } });
        expect(t.jar.get('laravel_session')).toBe('sess');
        // The ONLY requests: /me at open (signed out) and /me with the code. No endpoint of Genie 2's own.
        expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/me', 'GET /api/v1/me']);
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
        expect(again).toEqual({ ok: false, reason: 'Tynn did not accept that code. Codes work once and expire 5 minutes after the Tynn page opens — open Tynn again for a fresh one.' });
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
        expect(await account.signIn(CODE)).toEqual({ ok: false, reason: 'Tynn could not be reached (getaddrinfo ENOTFOUND tynn.example)' });
        expect(account.status()).toEqual({ signedIn: false });
    });
});

describe('TynnAccount across launches', () => {
    it('a later launch is still signed in: the session cookie answers /api/v1/me', async () => {
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

    it('Tynn unreachable at launch: signed out for now, and the session cookies are KEPT for when it answers', async () => {
        const t = fakeTynn();
        await (await TynnAccount.open(t.ports)).signIn(CODE);
        t.state.reachable = false;
        const offline = await TynnAccount.open(t.ports);
        expect(offline.status()).toEqual({ signedIn: false });
        expect(t.jar.get('laravel_session')).toBe('sess');
        t.state.reachable = true;
        expect(await offline.recheck()).toEqual({ signedIn: true, host: HOST, user: { name: 'Ada', email: 'ada@example.com' } });
    });
});

describe('TynnAccount.signOut', () => {
    it('ends the session at Tynn (POST /logout with its XSRF token), then clears the cookies', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        const changes: boolean[] = [];
        account.onChange(() => changes.push(account.status().signedIn));

        expect(await account.signOut()).toEqual({ ok: true, revoked: true });
        expect(t.calls.at(-1)).toMatchObject({ method: 'POST', path: '/logout', headers: { 'X-XSRF-TOKEN': 'xsrf=value', 'X-Requested-With': 'XMLHttpRequest' } });
        expect(t.jar.size).toBe(0);
        expect(account.status()).toEqual({ signedIn: false });
        expect(changes).toEqual([false]);
    });

    it('Tynn unreachable: this Genie is still signed out (cookies cleared), and says the Tynn session ends on its own', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        t.state.reachable = false;
        expect(await account.signOut()).toEqual({ ok: true, revoked: false, reason: 'Tynn could not be reached (getaddrinfo ENOTFOUND tynn.example) — this Genie is signed out; the Tynn session ends when it expires.' });
        expect(t.jar.size).toBe(0);
    });
});

describe('TynnAccount.request — every call rides the session', () => {
    it('a write carries X-XSRF-TOKEN (decoded) and the JSON body; a read carries none', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        const res = await account.request('/api/v1/user/issue-watch/refresh', { method: 'POST', body: { project_id: 'p1' } });
        expect(res.status).toBe(200);
        expect(t.calls.at(-1)).toEqual({ method: 'POST', path: '/api/v1/user/issue-watch/refresh', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': 'xsrf=value' }, body: { project_id: 'p1' } });
        await account.request('/api/v1/projects', { method: 'GET' });
        expect(t.calls.at(-1)!.headers).toEqual({ Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' });
    });

    // Tynn #839: revoking a share link is a DELETE (Genie 1's revokeWorkspaceShareLink) — a write, so it carries the token.
    it('a DELETE is a write: it carries X-XSRF-TOKEN', async () => {
        const t = fakeTynn();
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        await account.request('/workstations/ws_1/share-links/inv_1', { method: 'DELETE' });
        expect(t.calls.find((c) => c.method === 'DELETE')).toMatchObject({ path: '/workstations/ws_1/share-links/inv_1', headers: { 'X-XSRF-TOKEN': 'xsrf=value' } });
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

    it('Tynn answering 404 because the session is gone (a failed auth reads as Not Found, 2026-10-19): Genie asks /me and shows signed out', async () => {
        const t = fakeTynn({ authFail: 404 });
        const account = await TynnAccount.open(t.ports);
        await account.signIn(CODE);
        const changes: boolean[] = [];
        account.onChange(() => changes.push(account.status().signedIn));
        t.endSession();
        expect((await account.request('/api/v1/projects', { method: 'GET' })).status).toBe(404);
        expect(t.calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/v1/me' });
        expect(account.status()).toEqual({ signedIn: false });
        expect(changes).toEqual([false]);
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
