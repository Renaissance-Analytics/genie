import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TynnAccount, type TynnAccountPorts } from '../src/main/tynn-account.js';

const HOST = 'https://tynn.example';
const CODE = 'aB3'.repeat(21) + 'x';
const TOKEN = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'1'.repeat(64)}`;
const OTHER_TOKEN = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'2'.repeat(64)}`;
const SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];
const USER = { id: '7', name: 'Ada', email: 'ada@example.com' };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-tynn-bearer-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fixture() {
    const jar = new Map<string, string>();
    const calls: Array<{ path: string; origin: string; init: any }> = [];
    const state = { encryption: true, live: false, session: false, scopes: SCOPES, exchanges: 0, error: '' };
    const file = join(dir, 'tynn.json');
    // Fake keychain port: verifies use of the cipher boundary, not a claim that base64 is encryption.
    const cipher = { isAvailable: () => state.encryption, encrypt: (text: string) => Buffer.from(`sealed:${text}`), decrypt: (bytes: Buffer) => bytes.toString().slice('sealed:'.length) };
    const ports = {
        host: () => HOST, file, cipher,
        cookies: { set: async (_host: string, name: string, value: string) => { jar.set(name, value); }, get: async (_host: string, name: string) => jar.get(name) ?? null, clear: async () => { jar.clear(); } },
        fetch: async (url: string, init: any) => {
            const target = new URL(url); const path = target.pathname;
            calls.push({ path, origin: target.origin, init });
            if (state.error) throw new Error(state.error);
            const answer = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
            if (target.origin !== HOST) return answer(403, { message: 'wrong origin' });
            const bearer = init.headers.Authorization ?? init.headers.authorization;
            const cookies = init.credentials !== 'omit';
            const session = cookies && state.session && jar.get('laravel_session') === 'sess';
            if (path === '/api/v1/me' && !bearer && cookies && jar.get('genie_token') === CODE && !session) {
                state.exchanges++; state.session = true; state.live = true;
                jar.set('laravel_session', 'sess'); jar.set('XSRF-TOKEN', 'xsrf');
                return answer(200, { ...USER, pairing_token: TOKEN, pairing_scopes: state.scopes });
            }
            if (bearer?.startsWith('Bearer gpk_') && (bearer !== `Bearer ${TOKEN}` || !state.live)) return answer(404, { message: 'Not Found' });
            const authenticated = bearer === `Bearer ${TOKEN}` && state.live;
            if (path === '/api/v1/me') return answer(authenticated || session ? 200 : 404, authenticated || session ? USER : {});
            if (path === '/api/v1/pairing-token' && init.method === 'DELETE') {
                if (!authenticated) return answer(404, {});
                state.live = false; return answer(200, { revoked: true });
            }
            if (path === '/logout' && session) { state.session = false; return answer(204, {}); }
            return answer(authenticated || session ? 200 : 404, { data: [] });
        },
    };
    const saved = (token = TOKEN) => writeFile(file, JSON.stringify({ version: 1, state: 'signed-in', host: HOST, userId: USER.id, scopes: SCOPES, tokenEnc: cipher.encrypt(token).toString('base64') }));
    return { ports: ports as unknown as TynnAccountPorts, state, calls, jar, file, cipher, saved };
}

describe('Tynn scoped bearer transport', () => {
    it('coalesces protocol and pasted-code pairing so one code cannot mint duplicate keys', async () => {
        const t = fixture(); const a = await TynnAccount.open(t.ports);
        const answers = await Promise.all([a.signIn(CODE), a.signIn(CODE)]);
        expect(answers.every((r) => r.ok)).toBe(true);
        expect(t.state.exchanges).toBe(1);
    });

    it('remembers consumed codes across sign-out and restart without retaining the raw code', async () => {
        const t = fixture(); const a = await TynnAccount.open(t.ports); await a.signIn(CODE); await a.signOut();
        const restarted = await TynnAccount.open(t.ports);
        expect((await restarted.signIn(CODE)).ok).toBe(false);
        expect(t.state.exchanges).toBe(1);
        expect(await readFile(t.file, 'utf8')).not.toContain(CODE);
    });

    it('retains the existing credential when a replacement pairing fails', async () => {
        const t = fixture(); const a = await TynnAccount.open(t.ports); await a.signIn(CODE);
        t.state.error = 'offline';
        expect((await a.signIn('b'.repeat(64))).ok).toBe(false);
        expect(a.status().signedIn).toBe(true);
        t.state.error = '';
        expect((await TynnAccount.open(t.ports)).status().signedIn).toBe(true);
    });

    it('keeps the one-time pairing credential encrypted, clears exchange cookies, and omits cookies on subsequent writes', async () => {
        const t = fixture(); const a = await TynnAccount.open(t.ports);
        expect((await a.signIn(CODE)).ok).toBe(true);
        const disk = await readFile(t.file, 'utf8');
        expect(disk).not.toContain(TOKEN);
        expect(t.cipher.decrypt(Buffer.from(JSON.parse(disk).tokenEnc, 'base64'))).toBe(TOKEN);
        expect(t.jar.size).toBe(0);
        await a.request('/api/v1/projects', { method: 'POST', body: { name: 'Project' } });
        expect(t.calls.at(-1)?.init).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${TOKEN}` } });
        expect(t.calls.at(-1)?.init.headers).not.toHaveProperty('X-XSRF-TOKEN');
        expect(JSON.stringify(a.status())).not.toContain(TOKEN);
    });

    it('restores the encrypted credential on restart without redeeming another code', async () => {
        const t = fixture(); t.state.live = true; await t.saved();
        const a = await TynnAccount.open(t.ports);
        expect(a.status()).toMatchObject({ signedIn: true, user: { name: 'Ada' } });
        expect(t.state.exchanges).toBe(0);
        expect(t.calls[0]?.init).toMatchObject({ credentials: 'omit', headers: { Authorization: `Bearer ${TOKEN}` } });
    });

    it('never uses a legacy session cookie to rescue a refused pairing bearer', async () => {
        const t = fixture(); t.state.live = true; t.state.session = true; t.jar.set('laravel_session', 'sess'); await t.saved(OTHER_TOKEN);
        const a = await TynnAccount.open(t.ports);
        expect(a.status()).toEqual({ signedIn: false });
        expect(t.calls.every((c) => c.init.credentials === 'omit')).toBe(true);
    });

    it('refuses to mint a credential without OS encryption', async () => {
        const t = fixture(); t.state.encryption = false;
        const a = await TynnAccount.open(t.ports);
        expect(await a.signIn(CODE)).toMatchObject({ ok: false });
        expect(t.state.exchanges).toBe(0);
        expect(a.status()).toEqual({ signedIn: false });
    });

    it('requires the approved desktop scopes instead of retaining the unrestricted exchange session', async () => {
        const t = fixture(); t.state.scopes = ['genie:discovery'];
        const a = await TynnAccount.open(t.ports);
        expect(await a.signIn(CODE)).toMatchObject({ ok: false });
        expect(a.status()).toEqual({ signedIn: false });
        expect(t.jar.size).toBe(0);
    });

    it('signs out by revoking its bearer, forgets it locally, and cannot restore the old sign-in', async () => {
        const t = fixture(); const a = await TynnAccount.open(t.ports); await a.signIn(CODE);
        expect(await a.signOut()).toMatchObject({ ok: true, revoked: true });
        expect(t.state.live).toBe(false);
        expect(t.calls.some((c) => c.path === '/api/v1/pairing-token' && c.init.method === 'DELETE')).toBe(true);
        expect(t.calls.some((c) => c.path === '/logout')).toBe(false);
        expect((await TynnAccount.open(t.ports)).status()).toEqual({ signedIn: false });
    });

    it('refuses request paths that could send a bearer outside the scoped API', async () => {
        const t = fixture(); const a = await TynnAccount.open(t.ports); await a.signIn(CODE);
        const mark = t.calls.length;
        await expect(a.request('@attacker.invalid/path', { method: 'GET' })).rejects.toThrow(/path|origin|API/i);
        expect(t.calls.slice(mark)).toEqual([]);
    });

    it('never includes a pairing token or handoff code in a public failure reason', async () => {
        const t = fixture(); const a = await TynnAccount.open(t.ports);
        t.state.error = `request failed: ${TOKEN}, code=${CODE}`;
        const r = await a.signIn(CODE);
        expect(r.ok).toBe(false);
        expect(t.calls.length).toBeGreaterThan(0);
        expect(JSON.stringify(r)).not.toContain(TOKEN);
        expect(JSON.stringify(r)).not.toContain(CODE);
    });
});
