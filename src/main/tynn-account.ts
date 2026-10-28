import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { signInCodeFrom, tynnSignInUrl } from '../core/tynn-sign-in.js';
import { migratePrivateCredential, preparePrivateCredential, writePrivateCredential } from './private-credentials.js';

/** The desktop pairing key stays encrypted in the main process. Exchange cookies are cleared;
 * subsequent API calls use only the scoped bearer, never the browser session. */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type SessionFetch = (url: string, init: { method: Method; headers: Record<string, string>; body?: string; credentials: 'include' | 'omit'; redirect: 'error'; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TynnAccountPorts {
    readonly file: string;
    /** Previous shared-home file; migration restricts this file, never its parent directory. */
    readonly legacyFile?: string;
    readonly cipher: { isAvailable(): boolean; encrypt(text: string): Buffer; decrypt(bytes: Buffer): string };
    /** Fixed Tynn origin in production; injected origin in isolated tests. */
    readonly host: () => string;
    /** The session's cookie jar, for the Tynn origin. */
    readonly cookies: {
        set(host: string, name: string, value: string): Promise<void>;
        get(host: string, name: string): Promise<string | null>;
        clear(host: string): Promise<void>;
    };
    /** Electron session fetch; credentials are explicitly included only during the code exchange. */
    readonly fetch: SessionFetch;
    /** Opens the person's browser; absent, or failing, the link stays on screen to open elsewhere. */
    readonly openExternal?: (url: string) => Promise<void>;
    /** One timer (`setTimeout` in the app): the retry after Tynn could not be reached. Absent = no retry (tests, headless). */
    readonly schedule?: (ms: number, fn: () => void) => () => void;
}

/**
 * How long after an UNREACHABLE check Genie asks again (the owner, 2026-10-21: an issue was filed and no agent was told —
 * one unreachable moment at launch had left Genie signed out for good). A bounded backoff, then it stops: never a poll.
 * Waking the computer and an agent asking IssueWatch ask again too (`recheck`).
 */
export const TYNN_RETRY_MS: readonly number[] = [30_000, 120_000, 600_000, 1_800_000];
/** One deadline includes response headers and body; a stalled service must not block account or agent startup. */
export const TYNN_REQUEST_TIMEOUT_MS = 30_000;

export interface TynnUser {
    readonly name: string;
    readonly email: string;
}

export type TynnStatus = { readonly signedIn: false } | { readonly signedIn: true; readonly host: string; readonly user: TynnUser };
export type SignInResult = { readonly ok: true; readonly user: TynnUser } | { readonly ok: false; readonly reason: string };
export type SignOutResult = { readonly ok: true; readonly revoked: true } | { readonly ok: true; readonly revoked: false; readonly reason: string };
export type TynnResponse = { ok: boolean; status: number; json(): Promise<unknown> };

/** What the Settings surface and the IPC need — the account as a port, faked in tests. */
export interface TynnAccountPort {
    status(): TynnStatus;
    host(): string;
    startSignIn(): Promise<{ url: string }>;
    signIn(input: string): Promise<SignInResult>;
    signOut(): Promise<SignOutResult>;
    onChange(listener: () => void): () => void;
}

interface Me {
    readonly id: string;
    readonly user: TynnUser;
}

const trimHost = (h: string) => h.trim().replace(/\/+$/, '');
const UNREACHABLE = 'Tynn could not be reached. Check your connection and try again.';
const REQUIRED_SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];
const tokenValid = (s: unknown): s is string => typeof s === 'string' && /^gpk_[0-9A-HJKMNP-TV-Z]{26}\.[a-f0-9]{64}$/i.test(s);
interface Credential { readonly token: string; readonly host: string; readonly userId: string; readonly scopes: readonly string[] }
const parseMe = (body: unknown): Me | null => {
    const b = body as Record<string, unknown> | null;
    return b && (typeof b.id === 'string' || typeof b.id === 'number') && String(b.id) !== '' && typeof b.name === 'string' && typeof b.email === 'string'
        ? { id: String(b.id), user: { name: b.name, email: b.email } } : null;
};

export class TynnAccount implements TynnAccountPort {
    readonly #ports: TynnAccountPorts;
    #me: Me | null = null;
    #meHost = '';
    #credential: Credential | null = null;
    #usedCodes: string[] = [];
    #authWork: Promise<unknown> = Promise.resolve();
    #diskWork: Promise<unknown> = Promise.resolve();
    readonly #listeners = new Set<() => void>();
    #retry: { step: number; cancel: () => void } | null = null;

    private constructor(ports: TynnAccountPorts) { this.#ports = ports; }

    static async open(ports: TynnAccountPorts): Promise<TynnAccount> {
        const account = new TynnAccount(ports);
        // A legacy browser session cannot recover a once-only pairing secret.
        await ports.cookies.clear(account.host());
        await account.#restore();
        if (account.#credential) {
            try { await account.#whoami(); } catch { account.#retryAfter(0); }
        }
        return account;
    }

    async #prepareStorage(): Promise<void> {
        if (this.#ports.legacyFile) await migratePrivateCredential(this.#ports.legacyFile, this.#ports.file);
        await preparePrivateCredential(this.#ports.file);
    }

    async #restore(): Promise<void> {
        try {
            await this.#prepareStorage();
            const text = await readFile(this.#ports.file, 'utf8');
            if (text.length > 32_768) return;
            const data = JSON.parse(text) as Record<string, unknown>;
            if (data.version !== 1 || data.host !== this.host()) return;
            if (Array.isArray(data.usedCodes)) this.#usedCodes = data.usedCodes.filter((s): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)).slice(-8);
            const scopes = data.scopes;
            if (data.state !== 'signed-in' || !this.#ports.cipher.isAvailable() || typeof data.tokenEnc !== 'string' || typeof data.userId !== 'string' || !Array.isArray(scopes) || !REQUIRED_SCOPES.every((s) => scopes.includes(s))) return;
            const token = this.#ports.cipher.decrypt(Buffer.from(data.tokenEnc, 'base64'));
            if (tokenValid(token)) this.#credential = { token, host: this.host(), userId: data.userId, scopes: scopes.filter((s): s is string => typeof s === 'string') };
        } catch { /* Missing, corrupt or locked credentials require pairing; never fall back to cookies. */ }
    }

    #persist(credential: Credential | null): Promise<void> {
        const run = async () => {
            if (this.#ports.legacyFile) await migratePrivateCredential(this.#ports.legacyFile, this.#ports.file);
            const data = credential ? {
                version: 1, state: 'signed-in', host: credential.host, userId: credential.userId, scopes: credential.scopes,
                tokenEnc: this.#ports.cipher.encrypt(credential.token).toString('base64'), usedCodes: this.#usedCodes,
            } : { version: 1, state: 'signed-out', host: this.host(), usedCodes: this.#usedCodes };
            await writePrivateCredential(this.#ports.file, JSON.stringify(data));
        };
        const work = this.#diskWork.then(run, run);
        this.#diskWork = work.catch(() => {});
        return work;
    }

    #serial<T>(fn: () => Promise<T>): Promise<T> {
        const work = this.#authWork.then(fn, fn);
        this.#authWork = work.catch(() => {});
        return work;
    }

    #retryAfter(step: number): void {
        this.#retry?.cancel(); this.#retry = null;
        const ms = TYNN_RETRY_MS[step];
        if (!this.#credential || !this.#ports.schedule || ms === undefined) return;
        const cancel = this.#ports.schedule(ms, () => {
            this.#retry = null;
            void this.#whoami().catch(() => this.#retryAfter(step + 1));
        });
        this.#retry = { step, cancel };
    }

    host(): string { return trimHost(this.#ports.host()); }
    status(): TynnStatus { return this.#me && this.#meHost === this.host() ? { signedIn: true, host: this.#meHost, user: this.#me.user } : { signedIn: false }; }
    userId(): string | null { return this.status().signedIn ? this.#me!.id : null; }
    /**
     * The saved credential's account, before Tynn has confirmed it this launch (genie#1234): an agent's own stored Tynn key
     * is usable off grid. `null` once signed out or the credential is forgotten.
     */
    savedUserId(): string | null { return this.#credential && this.#credential.host === this.host() ? this.#credential.userId : null; }
    onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
    #set(me: Me | null, host = this.host()): void {
        const previous = JSON.stringify(this.status());
        this.#me = me; this.#meHost = me ? host : '';
        if (previous !== JSON.stringify(this.status())) for (const l of this.#listeners) l();
    }

    async #forget(credential: Credential): Promise<void> {
        if (this.#credential !== credential) return;
        this.#credential = null; this.#retry?.cancel(); this.#retry = null; this.#set(null);
        await this.#persist(null);
    }

    /*
     * TYNN ANSWERS EVERY UNAUTHORIZED REQUEST WITH 404 — by design, so bots get nothing but 400/404, and it will not change
     * (the owner, genie#1234 / PR #1236). A deploy or a routing fault answers 404 too, and nothing tells the two apart. So a
     * 404 from /me shows SIGNED OUT now, KEEPS the saved credential, and the caller schedules the backoff re-check (the
     * thrown UNREACHABLE does that everywhere a check can fail): a passing 404 heals itself with no new sign-in, and a real
     * revocation stays signed out until the person pairs again, when the new pairing replaces the credential. Forgetting
     * the credential on a 404 signed Genie out for good and broke every Tynn-linked agent.
     *
     * 401/419 (Tynn never sends them; an explicit auth refusal if anything ever does) still forget at once: the account
     * stays signed out until it is paired again, which is what a revocation means.
     */
    #unconfirmed(): void { this.#set(null); }

    async #whoami(signal?: AbortSignal): Promise<void> {
        const credential = this.#credential;
        if (!credential || credential.host !== this.host()) return;
        const res = await this.#fetch('/api/v1/me', { method: 'GET', ...(signal ? { signal } : {}) }, credential);
        if (this.#credential !== credential) return;
        if (res.status === 401 || res.status === 419) { await this.#forget(credential); return; }
        if (res.status === 404) { this.#unconfirmed(); throw new Error(UNREACHABLE); }
        if (!res.ok) throw new Error(UNREACHABLE);
        const me = parseMe(await res.json());
        if (this.#credential !== credential) return;
        if (!me || me.id !== credential.userId) { await this.#forget(credential); return; }
        this.#set(me, credential.host);
    }

    async recheck(): Promise<TynnStatus> {
        this.#retry?.cancel(); this.#retry = null;
        try { await this.#whoami(); } catch { this.#retryAfter(0); }
        return this.status();
    }

    async startSignIn(): Promise<{ url: string }> {
        const url = tynnSignInUrl(this.host());
        try { await this.#ports.openExternal?.(url); } catch { /* The visible link remains usable. */ }
        return { url };
    }

    signIn(input: string): Promise<SignInResult> { return this.#serial(() => this.#signIn(input)).catch(() => ({ ok: false, reason: 'Tynn pairing could not be completed. Check your connection and OS keychain, then try again.' })); }
    async #signIn(input: string): Promise<SignInResult> {
        const code = signInCodeFrom(input);
        if (code === null) return { ok: false, reason: 'That is not a Tynn sign-in code. Paste the code Tynn shows after you sign in — 64 letters and digits.' };
        const hash = createHash('sha256').update(code).digest('hex');
        if (this.#usedCodes.includes(hash)) return this.status().signedIn ? { ok: true, user: this.#me!.user } : { ok: false, reason: 'That code was already used. Open Tynn again for a fresh sign-in code.' };
        if (!this.#ports.cipher.isAvailable()) return { ok: false, reason: 'OS credential encryption is unavailable. Unlock your keychain before pairing Tynn.' };
        await this.#prepareStorage();
        const host = this.host();
        const previous = { credential: this.#credential, me: this.#me, host: this.#meHost };
        this.#retry?.cancel(); this.#retry = null; this.#credential = null; this.#set(null);
        let issued: Credential | null = null;
        let accepted = false;
        try {
            await this.#ports.cookies.clear(host);
            await this.#ports.cookies.set(host, 'genie_token', code);
            const res = await this.#fetch('/api/v1/me', { method: 'GET' }, null, host);
            if (!res.ok) return { ok: false, reason: 'Tynn did not accept that code. Codes work once and expire 5 minutes after the Tynn page opens — open Tynn again for a fresh one.' };
            const body = await res.json() as Record<string, unknown> | null;
            const me = parseMe(body);
            if (me && tokenValid(body?.pairing_token)) issued = { token: body.pairing_token, host, userId: me.id, scopes: Array.isArray(body.pairing_scopes) ? body.pairing_scopes.filter((s): s is string => typeof s === 'string') : [] };
            if (!issued || !REQUIRED_SCOPES.every((s) => issued!.scopes.includes(s))) return { ok: false, reason: 'Tynn did not issue the required scoped desktop credential. Update Tynn and pair again.' };
            await this.#ports.cookies.clear(host);
            this.#usedCodes = [...this.#usedCodes, hash].slice(-8);
            await this.#persist(issued);
            this.#credential = issued; this.#set(me, host); accepted = true;
            return { ok: true, user: me!.user };
        } catch { return { ok: false, reason: 'Tynn pairing could not be completed. Check your connection and OS keychain, then try again.' }; }
        finally {
            if (!accepted) {
                this.#credential = previous.credential;
                this.#set(previous.me, previous.host);
                await this.#ports.cookies.clear(host);
            }
            // A key minted but not durably accepted must not silently remain live.
            if (issued && !accepted) await this.#fetch('/api/v1/pairing-token', { method: 'DELETE' }, issued).catch(() => {});
        }
    }

    signOut(): Promise<SignOutResult> { return this.#serial<SignOutResult>(async () => {
        const credential = this.#credential;
        this.#credential = null; this.#retry?.cancel(); this.#retry = null; this.#set(null);
        await this.#persist(null);
        await this.#ports.cookies.clear(this.host());
        if (!credential) return { ok: true, revoked: true };
        try {
            const res = await this.#fetch('/api/v1/pairing-token', { method: 'DELETE' }, credential);
            const body = res.ok ? await res.json() as { revoked?: unknown } : null;
            if (body?.revoked === true) return { ok: true, revoked: true };
        } catch { /* Local sign-out is durable even when remote revocation cannot be confirmed. */ }
        return { ok: true, revoked: false, reason: 'This Genie is signed out. Tynn credential revocation could not be confirmed; revoke this device in Tynn if it remains listed.' };
    }).catch(() => { throw new Error('Local Tynn sign-out could not be saved. Try again before closing Genie.'); }); }

    async request(path: string, init: { method: Method; body?: unknown; signal?: AbortSignal }): Promise<TynnResponse> {
        const credential = this.#credential;
        if (!credential || credential.host !== this.host()) throw new Error('Sign in to Tynn first');
        const res = await this.#fetch(path, init, credential);
        if (this.#credential === credential) {
            if (res.status === 401 || res.status === 419) await this.#forget(credential);
            else if (res.status === 404 && path === '/api/v1/me') { this.#unconfirmed(); if (!this.#retry) this.#retryAfter(0); }
            else if (res.status === 404) {
                // A 404 is Tynn's "not authorized" as well as "not found": /me decides, and a 404 there signs out (kept).
                try { await this.#whoami(init.signal); }
                catch (error) { if (init.signal?.aborted) throw error; if (!this.#retry) this.#retryAfter(0); }
            }
        }
        return res;
    }

    async #fetch(path: string, init: { method: Method; body?: unknown; signal?: AbortSignal }, credential: Credential | null, exchangeHost?: string): Promise<TynnResponse> {
        const host = credential?.host ?? exchangeHost ?? this.host();
        if (!path.startsWith('/api/v1/') || path.includes('\\') || /[\r\n]/.test(path)) throw new Error('Invalid Tynn API path');
        const url = new URL(`${host}${path}`);
        if (url.origin !== new URL(host).origin || !url.pathname.startsWith('/api/v1/') || url.username || url.password) throw new Error('Invalid Tynn API origin or path');
        const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
        if (credential) headers.Authorization = `Bearer ${credential.token}`;
        if (init.body !== undefined) headers['Content-Type'] = 'application/json';
        const cancelled = () => Object.assign(new Error('Tynn request cancelled.'), { name: 'AbortError' });
        if (init.signal?.aborted) throw cancelled();
        const controller = new AbortController();
        let interrupt!: () => void;
        const interrupted = new Promise<never>((_resolve, reject) => {
            interrupt = () => {
                reject(init.signal?.aborted ? cancelled() : new Error(UNREACHABLE));
                controller.abort();
            };
        });
        const timer = setTimeout(interrupt, TYNN_REQUEST_TIMEOUT_MS);
        init.signal?.addEventListener('abort', interrupt, { once: true });
        const cleanup = () => {
            clearTimeout(timer);
            init.signal?.removeEventListener('abort', interrupt);
        };
        const failure = () => init.signal?.aborted ? cancelled() : new Error(UNREACHABLE);
        try {
            const res = await Promise.race([this.#ports.fetch(url.href, {
                method: init.method, headers, credentials: credential ? 'omit' : 'include', redirect: 'error', signal: controller.signal,
                ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
            }), interrupted]);
            // Return headers promptly for auth handling; the body retains the same deadline and cancellation.
            const body = Promise.race([res.text(), interrupted]).catch(() => { throw failure(); }).finally(cleanup);
            // A status-only caller need not read json(), but its failed/aborted body must still be handled.
            void body.catch(() => {});
            return { ok: res.ok, status: res.status, json: async () => { const text = await body; return text === '' ? null : JSON.parse(text) as unknown; } };
        } catch { cleanup(); throw failure(); }
    }

    /** The person's projects — Genie 1's GET /api/v1/projects. Signed out is refused before any request. */
    async projects(): Promise<unknown[]> {
        if (!this.status().signedIn) throw new Error('Sign in to Tynn first (Settings → Accounts → Tynn → Open Tynn in your browser)');
        const res = await this.request('/api/v1/projects', { method: 'GET' });
        if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
            throw new Error(`Tynn answered ${res.status}${typeof body?.message === 'string' ? `: ${body.message}` : ''}`);
        }
        const body = (await res.json()) as { data?: unknown };
        return Array.isArray(body.data) ? body.data : [];
    }

    /** Who a new project may belong to — Genie 1's GET /api/v1/projects/owner-options (Tynn's `data`). */
    async ownerOptions(): Promise<unknown[]> {
        if (!this.status().signedIn) throw new Error('Sign in to Tynn first (Settings → Accounts → Tynn → Open Tynn in your browser)');
        const res = await this.request('/api/v1/projects/owner-options', { method: 'GET' });
        if (!res.ok) throw new Error(await tynnRefusal(res));
        const body = (await res.json()) as { data?: unknown } | null;
        return Array.isArray(body?.data) ? body.data : [];
    }

    /**
     * A new Tynn project — Genie 1's POST /api/v1/projects (MeApiController::createProject): the body as given, Tynn's
     * `data` (the same row the project list gives) back. Tynn's own words when it refuses: a 422's message, a 403 named.
     */
    async createProject(body: { name: string; slug?: string; owner_type?: 'user' | 'organization' | 'team'; owner_id?: string }): Promise<unknown> {
        if (!this.status().signedIn) throw new Error('Sign in to Tynn first (Settings → Accounts → Tynn → Open Tynn in your browser)');
        const res = await this.request('/api/v1/projects', { method: 'POST', body });
        if (res.status === 403) throw new Error('Tynn does not let you create a project under that owner');
        if (!res.ok) throw new Error(await tynnRefusal(res));
        const answer = (await res.json()) as { data?: unknown } | null;
        return answer?.data ?? null;
    }
}

/** A refusal in Tynn's words: its `message` (Laravel's validation and errors), else its `error` code, else the status. */
async function tynnRefusal(res: TynnResponse): Promise<string> {
    const body = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown } | null;
    if (typeof body?.message === 'string' && body.message.trim() !== '') return body.message;
    return `Tynn answered ${res.status}${typeof body?.error === 'string' ? `: ${body.error}` : ''}`;
}
