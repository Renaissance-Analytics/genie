import { signInCodeFrom, tynnSignInUrl } from '../core/tynn-sign-in.js';

/**
 * THIS GENIE'S TYNN ACCOUNT — GENIE 1'S SESSION, AS IT WAS (the owner, 2026-10-19: "tynn already had this half.
 * everything was already working in genie 1").
 *
 * Genie 1 (`v1:main/auth.ts` `redeemToken`, `main/backend/tynn.ts` `fetch`): the single-use code from /genie/callback
 * is dropped as a `genie_token` cookie on the Tynn origin, and `GET /api/v1/me` swaps it for a real Tynn session —
 * Tynn's GenieAuthController::exchange. Every call after that rides the session's cookies through a session-bound
 * fetch; a write carries the `X-XSRF-TOKEN` Laravel checks, read from the `XSRF-TOKEN` cookie. Nothing on Tynn's side is
 * Genie 2's own, and Genie keeps no key: the cookies live in Electron's persistent `persist:tynn` session, which the
 * OS's own encryption protects (main.ts).
 *
 * Sign out ends the session at Tynn (`POST /logout`, Fortify's) and clears the cookies; Tynn unreachable, the cookies
 * are cleared anyway and the person is told the Tynn session ends when it expires.
 */

export type SessionFetch = (url: string, init: { method: 'GET' | 'POST' | 'DELETE'; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TynnAccountPorts {
    /** The Tynn host from settings, read at call time. */
    readonly host: () => string;
    /** The session's cookie jar, for the Tynn origin. */
    readonly cookies: {
        set(host: string, name: string, value: string): Promise<void>;
        get(host: string, name: string): Promise<string | null>;
        clear(host: string): Promise<void>;
    };
    /** Fetch bound to that session: its cookies ride along, and a Set-Cookie lands in it. */
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
const reach = (error: unknown) => `Tynn could not be reached (${error instanceof Error ? error.message : String(error)})`;

export class TynnAccount implements TynnAccountPort {
    readonly #ports: TynnAccountPorts;
    #me: Me | null = null;
    #meHost = '';
    readonly #listeners = new Set<() => void>();

    private constructor(ports: TynnAccountPorts) {
        this.#ports = ports;
    }

    /** Asks Tynn who the session belongs to. Unreachable = signed out FOR NOW: the cookies are kept for `recheck`. */
    static async open(ports: TynnAccountPorts): Promise<TynnAccount> {
        const account = new TynnAccount(ports);
        try {
            await account.#whoami();
        } catch {
            // Offline at launch: shown signed out; nothing is cleared, and Genie asks again on the backoff.
            account.#retryAfter(0);
        }
        return account;
    }

    /** The pending retry, if any, and which step of the backoff it is. */
    #retry: { step: number; cancel: () => void } | null = null;

    #retryAfter(step: number): void {
        this.#retry?.cancel();
        this.#retry = null;
        const schedule = this.#ports.schedule;
        const ms = TYNN_RETRY_MS[step];
        if (!schedule || ms === undefined) return;
        const cancel = schedule(ms, () => {
            this.#retry = null;
            void this.#whoami().catch(() => this.#retryAfter(step + 1));
        });
        this.#retry = { step, cancel };
    }

    host(): string {
        return trimHost(this.#ports.host());
    }

    status(): TynnStatus {
        return this.#me && this.#meHost === this.host() ? { signedIn: true, host: this.#meHost, user: this.#me.user } : { signedIn: false };
    }

    /** The person's id — their own push channel is `private-App.Models.User.<id>` — only while signed in. */
    userId(): string | null {
        return this.status().signedIn ? this.#me!.id : null;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #set(me: Me | null): void {
        const was = this.status().signedIn;
        this.#me = me;
        this.#meHost = me ? this.host() : '';
        if (was !== this.status().signedIn) for (const l of this.#listeners) l();
    }

    /** GET /api/v1/me over the session: who it belongs to, or null. Throws only when Tynn cannot be reached. */
    async #whoami(): Promise<Me | null> {
        const res = await this.#raw('/api/v1/me', { method: 'GET' });
        let me: Me | null = null;
        if (res.ok) {
            const body = (await res.json().catch(() => null)) as { id?: unknown; name?: unknown; email?: unknown } | null;
            if (body && (typeof body.id === 'string' || typeof body.id === 'number') && typeof body.name === 'string' && typeof body.email === 'string') {
                me = { id: String(body.id), user: { name: body.name, email: body.email } };
            }
        }
        this.#set(me);
        return me;
    }

    /** Ask Tynn again now (waking from sleep, an agent asking IssueWatch): a pending retry gives way to it. */
    async recheck(): Promise<TynnStatus> {
        this.#retry?.cancel();
        this.#retry = null;
        try {
            await this.#whoami();
        } catch {
            // Still unreachable: unchanged, and the backoff starts again.
            this.#retryAfter(0);
        }
        return this.status();
    }

    async startSignIn(): Promise<{ url: string }> {
        const url = tynnSignInUrl(this.host());
        try {
            await this.#ports.openExternal?.(url);
        } catch {
            // No browser here: the link is shown to open on another device, and the code is pasted back.
        }
        return { url };
    }

    /** Genie 1's redeemToken: the code as `genie_token` on the Tynn origin, then /api/v1/me swaps it for the session. */
    async signIn(input: string): Promise<SignInResult> {
        const code = signInCodeFrom(input);
        if (code === null) return { ok: false, reason: 'That is not a Tynn sign-in code. Paste the code Tynn shows after you sign in — 64 letters and digits.' };
        const host = this.host();
        await this.#ports.cookies.set(host, 'genie_token', code);
        let me: Me | null;
        try {
            me = await this.#whoami();
        } catch (error) {
            return { ok: false, reason: reach(error) };
        }
        if (!me) {
            // Spent or expired: no dead code is left in the jar to be sent again.
            await this.#ports.cookies.clear(host);
            return { ok: false, reason: 'Tynn did not accept that code. Codes work once and expire 5 minutes after the Tynn page opens — open Tynn again for a fresh one.' };
        }
        return { ok: true, user: me.user };
    }

    async signOut(): Promise<SignOutResult> {
        const host = this.host();
        let unreached: string | null = null;
        try {
            await this.#raw('/logout', { method: 'POST' });
        } catch (error) {
            unreached = reach(error);
        }
        await this.#ports.cookies.clear(host);
        this.#set(null);
        if (unreached === null) return { ok: true, revoked: true };
        return { ok: true, revoked: false, reason: `${unreached} — this Genie is signed out; the Tynn session ends when it expires.` };
    }

    /**
     * One call over the session, as Genie 1's TynnBackend.fetch made it. A 401 or 419 means Tynn no longer has this
     * session: this Genie shows signed out (the cookies stay; signing in again replaces them).
     *
     * A 404 is ambiguous ON PURPOSE: Tynn answers a failed auth exactly as it answers a path that is not there (the
     * owner, 2026-10-19 — attackers must not learn what exists). So a 404 while signed in asks /api/v1/me once: it
     * answers who this session belongs to, or this Genie shows signed out.
     */
    async request(path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<TynnResponse> {
        const res = await this.#raw(path, init);
        if (res.status === 401 || res.status === 419) this.#set(null);
        else if (res.status === 404 && path !== '/api/v1/me' && this.status().signedIn) {
            try {
                await this.#whoami();
            } catch {
                // Tynn unreachable for the check: unchanged until it answers.
            }
        }
        return res;
    }

    async #raw(path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<TynnResponse> {
        const host = this.host();
        const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
        if (init.body !== undefined) headers['Content-Type'] = 'application/json';
        if (init.method !== 'GET') {
            const xsrf = await this.#ports.cookies.get(host, 'XSRF-TOKEN');
            if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
        }
        const res = await this.#ports.fetch(`${host}${path}`, { method: init.method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
        return {
            ok: res.ok,
            status: res.status,
            json: async () => {
                const text = await res.text();
                return text === '' ? null : (JSON.parse(text) as unknown);
            },
        };
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
