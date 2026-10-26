import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { signInCodeFrom, tynnSignInUrl } from '../core/tynn-sign-in.js';

/** The desktop pairing key stays encrypted in the main process. Exchange cookies are cleared;
 * subsequent API calls use only the scoped bearer, never the browser session. */
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type SessionFetch = (url: string, init: { method: Method; headers: Record<string, string>; body?: string; credentials: 'include' | 'omit'; redirect: 'error' }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TynnAccountPorts {
    readonly file: string;
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

    async #restore(): Promise<void> {
        try {
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
            const data = credential ? {
                version: 1, state: 'signed-in', host: credential.host, userId: credential.userId, scopes: credential.scopes,
                tokenEnc: this.#ports.cipher.encrypt(credential.token).toString('base64'), usedCodes: this.#usedCodes,
            } : { version: 1, state: 'signed-out', host: this.host(), usedCodes: this.#usedCodes };
            await mkdir(dirname(this.#ports.file), { recursive: true, mode: 0o700 });
            const temp = `${this.#ports.file}.${randomUUID()}.tmp`;
            try {
                await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
                await rename(temp, this.#ports.file);
            } finally { await rm(temp, { force: true }).catch(() => {}); }
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

    async #whoami(): Promise<void> {
        const credential = this.#credential;
        if (!credential || credential.host !== this.host()) return;
        const res = await this.#fetch('/api/v1/me', { method: 'GET' }, credential);
        if (this.#credential !== credential) return;
        if ([401, 404, 419].includes(res.status)) { await this.#forget(credential); return; }
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

    async request(path: string, init: { method: Method; body?: unknown }): Promise<TynnResponse> {
        const credential = this.#credential;
        if (!credential || credential.host !== this.host()) throw new Error('Sign in to Tynn first');
        const res = await this.#fetch(path, init, credential);
        if (this.#credential === credential) {
            if (res.status === 401 || res.status === 419) await this.#forget(credential);
            else if (res.status === 404 && path !== '/api/v1/me') { try { await this.#whoami(); } catch { /* A transient check retains the saved credential. */ } }
        }
        return res;
    }

    async #fetch(path: string, init: { method: Method; body?: unknown }, credential: Credential | null, exchangeHost?: string): Promise<TynnResponse> {
        const host = credential?.host ?? exchangeHost ?? this.host();
        if (!path.startsWith('/api/v1/') || path.includes('\\') || /[\r\n]/.test(path)) throw new Error('Invalid Tynn API path');
        const url = new URL(`${host}${path}`);
        if (url.origin !== new URL(host).origin || !url.pathname.startsWith('/api/v1/') || url.username || url.password) throw new Error('Invalid Tynn API origin or path');
        const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
        if (credential) headers.Authorization = `Bearer ${credential.token}`;
        if (init.body !== undefined) headers['Content-Type'] = 'application/json';
        let res: Awaited<ReturnType<SessionFetch>>;
        try { res = await this.#ports.fetch(url.href, { method: init.method, headers, credentials: credential ? 'omit' : 'include', redirect: 'error', ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }); }
        catch { throw new Error(UNREACHABLE); }
        return { ok: res.ok, status: res.status, json: async () => { const text = await res.text(); return text === '' ? null : JSON.parse(text) as unknown; } };
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
