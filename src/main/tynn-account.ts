import { signInCodeFrom, tynnSignInUrl } from '../core/tynn-sign-in.js';

/**
 * THIS GENIE'S TYNN ACCOUNT (the owner, 2026-10-19: Tynn sign-in the way Genie 1 did).
 *
 * Genie 1 swapped the browser's single-use code for a browser SESSION. Genie 2 talks to Tynn's API with a bearer, so it
 * swaps the same code once (`POST /api/v1/genie/sign-in`) for an ACCOUNT KEY named for this computer — "Genie — Office
 * PC" on Tynn's Account → Tokens, revocable there. The key is kept only through the secret store (Electron's safeStorage,
 * main.ts) — never in settings.json — and only for the host that minted it. Sign out revokes it at Tynn with the key
 * itself, then forgets it; Tynn unreachable, it is still forgotten here and the person is told it is live at Tynn.
 */

export type FetchInit = { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string };
export type AccountFetch = (url: string, init: FetchInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SecretStore {
    read(): Promise<string | null>;
    write(value: string): Promise<void>;
    clear(): Promise<void>;
}

export interface TynnAccountPorts {
    fetch: AccountFetch;
    readonly store: SecretStore;
    /** The Tynn host from settings, read at call time. */
    readonly host: () => string;
    /** What this computer is called on Tynn's token list. */
    readonly device: () => string;
    /** Opens the person's browser; absent, or failing, the link stays on screen to open elsewhere. */
    readonly openExternal?: (url: string) => Promise<void>;
}

export interface TynnUser {
    readonly name: string;
    readonly email: string;
}

export type TynnStatus = { readonly signedIn: false } | { readonly signedIn: true; readonly host: string; readonly user: TynnUser };
export type SignInResult = { readonly ok: true; readonly user: TynnUser } | { readonly ok: false; readonly reason: string };
export type SignOutResult = { readonly ok: true; readonly revoked: true } | { readonly ok: true; readonly revoked: false; readonly reason: string };

/** What the Settings surface and the IPC need — the account as a port, faked in tests. */
export interface TynnAccountPort {
    status(): TynnStatus;
    host(): string;
    startSignIn(): Promise<{ url: string }>;
    signIn(input: string): Promise<SignInResult>;
    signOut(): Promise<SignOutResult>;
    onChange(listener: () => void): () => void;
}

interface Stored {
    readonly host: string;
    readonly token: string;
    readonly device: string;
    readonly user: TynnUser;
}

const trimHost = (h: string) => h.trim().replace(/\/+$/, '');

function parseStored(raw: string | null): Stored | null {
    if (raw === null) return null;
    try {
        const v = JSON.parse(raw) as Partial<Stored>;
        if (typeof v.host !== 'string' || typeof v.token !== 'string' || !v.token.startsWith('aak_') || typeof v.device !== 'string') return null;
        if (typeof v.user?.name !== 'string' || typeof v.user.email !== 'string') return null;
        return { host: v.host, token: v.token, device: v.device, user: { name: v.user.name, email: v.user.email } };
    } catch {
        return null;
    }
}

async function tynnWords(res: { status: number; text(): Promise<string> }): Promise<string> {
    const text = await res.text().catch(() => '');
    let message = text.slice(0, 200);
    try {
        const body = JSON.parse(text) as { message?: unknown };
        if (typeof body.message === 'string') message = body.message;
    } catch {
        // Not JSON: the raw text is the message.
    }
    return `Tynn answered ${res.status}: ${message}`;
}

export class TynnAccount implements TynnAccountPort {
    readonly #ports: TynnAccountPorts;
    #stored: Stored | null;
    readonly #listeners = new Set<() => void>();

    private constructor(ports: TynnAccountPorts, stored: Stored | null) {
        this.#ports = ports;
        this.#stored = stored;
    }

    static async open(ports: TynnAccountPorts): Promise<TynnAccount> {
        let raw: string | null = null;
        try {
            raw = await ports.store.read();
        } catch {
            // An unreadable store (a key the OS keychain no longer opens) is signed out, not a crash.
        }
        return new TynnAccount(ports, parseStored(raw));
    }

    host(): string {
        return trimHost(this.#ports.host());
    }

    /** The stored key, only for the host that minted it: a key is never sent to another Tynn. */
    #current(): Stored | null {
        return this.#stored && this.#stored.host === this.host() ? this.#stored : null;
    }

    status(): TynnStatus {
        const s = this.#current();
        return s ? { signedIn: true, host: s.host, user: s.user } : { signedIn: false };
    }

    /** The bearer for Tynn's API — '' when signed out. */
    token(): string {
        return this.#current()?.token ?? '';
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        for (const l of this.#listeners) l();
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

    async signIn(input: string): Promise<SignInResult> {
        const code = signInCodeFrom(input);
        if (code === null) return { ok: false, reason: 'That is not a Tynn sign-in code. Paste the code Tynn shows after you sign in — 64 letters and digits.' };
        const host = this.host();
        const device = this.#ports.device().trim().slice(0, 100);
        let res: Awaited<ReturnType<AccountFetch>>;
        try {
            res = await this.#ports.fetch(`${host}/api/v1/genie/sign-in`, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, device }),
            });
        } catch (error) {
            return { ok: false, reason: `Tynn could not be reached (${error instanceof Error ? error.message : String(error)})` };
        }
        if (!res.ok) return { ok: false, reason: await tynnWords(res) };
        let body: { token?: unknown; user?: { name?: unknown; email?: unknown } };
        try {
            body = JSON.parse(await res.text()) as typeof body;
        } catch {
            return { ok: false, reason: 'Tynn’s answer was not JSON' };
        }
        if (typeof body.token !== 'string' || !body.token.startsWith('aak_') || typeof body.user?.name !== 'string' || typeof body.user.email !== 'string') {
            return { ok: false, reason: 'Tynn answered without a key — nothing was stored' };
        }
        const stored: Stored = { host, token: body.token, device, user: { name: body.user.name, email: body.user.email } };
        try {
            await this.#ports.store.write(JSON.stringify(stored));
        } catch (error) {
            // Never kept in the clear instead: no encrypted store, no sign-in (the key Tynn just made is unused; it lists on Account → Tokens).
            return { ok: false, reason: `the key could not be kept safely on this machine (${error instanceof Error ? error.message : String(error)}) — nothing was stored; revoke “Genie — ${device}” on Tynn under Account → Tokens` };
        }
        this.#stored = stored;
        this.#changed();
        return { ok: true, user: stored.user };
    }

    async signOut(): Promise<SignOutResult> {
        const s = this.#stored;
        if (!s) return { ok: true, revoked: true };
        let unrevoked: string | null = null;
        try {
            const res = await this.#ports.fetch(`${s.host}/api/v1/genie/sign-out`, { method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${s.token}` } });
            // 401/403: Tynn no longer accepts the key (revoked on Account → Tokens already) — there is nothing left to revoke.
            if (!res.ok && res.status !== 401 && res.status !== 403) unrevoked = await tynnWords(res);
        } catch (error) {
            unrevoked = `Tynn could not be reached (${error instanceof Error ? error.message : String(error)})`;
        }
        await this.#ports.store.clear();
        this.#stored = null;
        this.#changed();
        if (unrevoked === null) return { ok: true, revoked: true };
        return { ok: true, revoked: false, reason: `${unrevoked} — the key “Genie — ${s.device}” is still listed on Tynn under Account → Tokens; revoke it there.` };
    }

    /** The person's projects, as Tynn's browser surface lists them. Signed out is refused before any request. */
    async projects(): Promise<unknown[]> {
        const s = this.#current();
        if (!s) throw new Error('Sign in to Tynn first (Settings → Workstation → Integrations → Open Tynn in your browser)');
        const res = await this.#ports.fetch(`${s.host}/api/v1/genie/projects`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${s.token}` } });
        if (!res.ok) throw new Error(await tynnWords(res));
        const body = JSON.parse(await res.text()) as { data?: unknown };
        return Array.isArray(body.data) ? body.data : [];
    }
}
