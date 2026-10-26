import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TynnAccount, type SessionFetch } from '../src/main/tynn-account.js';
import { fakeTynnStorage, PAIRING_SCOPES, PAIRING_TOKEN } from './helpers/tynn-storage.js';

const DEADLINE = 30_000;
const USER = { id: 'deadline-user', name: 'Ada', email: 'ada@example.invalid' };
const CODE = 'x'.repeat(64);
const UNREACHABLE = 'Tynn could not be reached. Check your connection and try again.';
const never = <T>(): Promise<T> => new Promise(() => {});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}
const reply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

async function fixture() {
    const storage = fakeTynnStorage();
    const state = { calls: 0, fetch: (async (_url, init) => reply(init.credentials === 'include' ? { ...USER, pairing_token: PAIRING_TOKEN, pairing_scopes: PAIRING_SCOPES } : USER)) as SessionFetch };
    const ports = { ...storage, host: () => 'https://fixture.invalid', cookies: { clear: async () => {}, get: async () => null, set: async () => {} },
        fetch: ((url, init) => { state.calls++; return state.fetch(url, init); }) as SessionFetch };
    const account = await TynnAccount.open(ports);
    expect((await account.signIn(CODE)).ok).toBe(true);
    state.calls = 0;
    return { account, ports, state };
}
// Observe settlement immediately so expected rejection never becomes an unhandled promise.
const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error }));
afterEach(() => { vi.useRealTimers(); });

describe('bounded Tynn account network requests', () => {
    it.each([401, 419])('confirmed auth refusal %s clears the account before a stalled response body completes', async (status) => {
        const t = await fixture(); let wireSignal: AbortSignal | undefined;
        t.state.fetch = async (_url, init) => { wireSignal = init.signal; return { ok: false, status, text: () => never() }; };
        vi.useFakeTimers();
        const result = outcome(t.account.request('/api/v1/projects', { method: 'GET' }));
        await vi.advanceTimersByTimeAsync(0);
        expect(t.account.status().signedIn, 'known authentication refusal is processed before waiting for its body').toBe(false);
        expect((await result).value?.status).toBe(status);
        await vi.advanceTimersByTimeAsync(DEADLINE);
        expect(wireSignal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
        expect(JSON.parse(await readFile(t.ports.file, 'utf8')).tokenEnc).toBeUndefined();
    });

    it('a nonresponsive fetch is aborted at 30 seconds without deleting or replacing the saved bearer', async () => {
        const t = await fixture(); const before = await readFile(t.ports.file, 'utf8');
        let wireSignal: AbortSignal | undefined;
        t.state.fetch = async (_url, init) => { wireSignal = init.signal; return never(); };
        vi.useFakeTimers();
        const result = outcome(t.account.request('/api/v1/projects', { method: 'GET' }));
        await vi.advanceTimersByTimeAsync(DEADLINE);
        expect(wireSignal?.aborted, 'the actual network operation is aborted').toBe(true);
        expect((await result).error?.message).toBe(UNREACHABLE);
        expect(t.state.calls).toBe(1); expect(t.account.status().signedIn).toBe(true);
        expect(await readFile(t.ports.file, 'utf8')).toBe(before);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('response headers do not reset the original deadline while its body stalls', async () => {
        const t = await fixture(); const headers = deferred<Awaited<ReturnType<SessionFetch>>>();
        let wireSignal: AbortSignal | undefined; const body = vi.fn(() => never<string>());
        t.state.fetch = async (_url, init) => { wireSignal = init.signal; return headers.promise; };
        vi.useFakeTimers();
        const result = outcome(t.account.request('/api/v1/projects', { method: 'GET' }).then((response) => response.json()));
        await vi.advanceTimersByTimeAsync(DEADLINE - 1);
        headers.resolve({ ok: true, status: 200, text: body });
        await vi.advanceTimersByTimeAsync(1);
        expect(wireSignal?.aborted, 'the body shares the original network deadline').toBe(true);
        expect(body).toHaveBeenCalledTimes(1);
        expect((await result).error?.message).toBe(UNREACHABLE);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an already-cancelled caller does not send the bearer or contact the network', async () => {
        const t = await fixture(); const controller = new AbortController(); controller.abort('private caller detail');
        t.state.fetch = async () => reply({ data: [] });
        const result = await outcome(t.account.request('/api/v1/projects', { method: 'GET', signal: controller.signal }));
        expect(t.state.calls).toBe(0); expect(result.error?.name).toBe('AbortError');
        expect(result.error?.message).toBe('Tynn request cancelled.');
        expect(t.account.status().signedIn).toBe(true);
    });

    it.each(['headers', 'body'] as const)('caller cancellation interrupts stalled %s, cleans its timer, and permits another request', async (phase) => {
        const t = await fixture(); const controller = new AbortController();
        const entered = deferred<void>(); let wireSignal: AbortSignal | undefined;
        t.state.fetch = async (_url, init) => {
            wireSignal = init.signal;
            if (phase === 'headers') { entered.resolve(); return never(); }
            return { ok: true, status: 200, text: () => { entered.resolve(); return never(); } };
        };
        vi.useFakeTimers();
        const result = outcome(t.account.request('/api/v1/projects', { method: 'GET', signal: controller.signal }).then((response) => response.json()));
        await entered.promise; controller.abort('do not echo private caller detail');
        await vi.advanceTimersByTimeAsync(0);
        expect(wireSignal?.aborted).toBe(true);
        expect((await result).error).toMatchObject({ name: 'AbortError', message: 'Tynn request cancelled.' });
        expect(vi.getTimerCount()).toBe(0);
        t.state.fetch = async () => reply({ data: ['next request works'] });
        expect(await (await t.account.request('/api/v1/projects', { method: 'GET' })).json()).toEqual({ data: ['next request works'] });
        expect(t.state.calls).toBe(2); expect(t.account.status().signedIn).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('successful responses finish before deadline and detach caller cancellation', async () => {
        const t = await fixture(); const controller = new AbortController(); let wireSignal: AbortSignal | undefined;
        t.state.fetch = async (_url, init) => { wireSignal = init.signal; return reply({ data: [] }); };
        vi.useFakeTimers();
        const response = await t.account.request('/api/v1/projects', { method: 'GET', signal: controller.signal });
        expect(await response.json()).toEqual({ data: [] }); expect(vi.getTimerCount()).toBe(0);
        controller.abort(); await vi.advanceTimersByTimeAsync(DEADLINE);
        expect(wireSignal?.aborted).toBe(false);
    });

    it('caller cancellation also interrupts the 404 account-verification request', async () => {
        const t = await fixture(); const controller = new AbortController(); const entered = deferred<void>();
        let verificationSignal: AbortSignal | undefined;
        t.state.fetch = async (url, init) => {
            if (url.endsWith('/projects')) return { ok: false, status: 404, text: async () => '{}' };
            expect(url.endsWith('/me')).toBe(true);
            verificationSignal = init.signal; entered.resolve(); return never();
        };
        vi.useFakeTimers();
        const result = outcome(t.account.request('/api/v1/projects', { method: 'GET', signal: controller.signal }));
        await entered.promise; controller.abort(); await vi.advanceTimersByTimeAsync(0);
        expect(verificationSignal?.aborted, '404 verification receives caller cancellation').toBe(true);
        expect((await result).error).toMatchObject({ name: 'AbortError', message: 'Tynn request cancelled.' });
        expect(t.account.status().signedIn).toBe(true); expect(t.state.calls).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('unresponsive remote revocation reports uncertainty after durable local sign-out', async () => {
        const t = await fixture(); const entered = deferred<void>(); let wireSignal: AbortSignal | undefined;
        t.state.fetch = async (_url, init) => { wireSignal = init.signal; entered.resolve(); return never(); };
        vi.useFakeTimers(); const result = t.account.signOut();
        await entered.promise; await vi.advanceTimersByTimeAsync(DEADLINE);
        expect(wireSignal?.aborted).toBe(true);
        expect(await result).toMatchObject({ ok: true, revoked: false });
        expect(t.account.status().signedIn).toBe(false);
        expect(JSON.parse(await readFile(t.ports.file, 'utf8')).tokenEnc).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an unresponsive startup check returns offline with its encrypted credential available for recheck', async () => {
        const t = await fixture(); const before = await readFile(t.ports.file, 'utf8');
        const entered = deferred<void>(); let wireSignal: AbortSignal | undefined;
        t.state.fetch = async (_url, init) => { wireSignal = init.signal; entered.resolve(); return never(); };
        vi.useFakeTimers(); const opening = TynnAccount.open(t.ports);
        await entered.promise; await vi.advanceTimersByTimeAsync(DEADLINE);
        expect(wireSignal?.aborted).toBe(true);
        const offline = await opening; expect(offline.status().signedIn).toBe(false);
        expect(await readFile(t.ports.file, 'utf8')).toBe(before);
        t.state.fetch = async () => reply(USER);
        expect((await offline.recheck()).signedIn).toBe(true); expect(vi.getTimerCount()).toBe(0);
    });
});
