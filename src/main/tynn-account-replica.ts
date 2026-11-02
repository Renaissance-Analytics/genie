import type { SignInResult, SignOutResult, TynnResponse, TynnStatus, TynnAccountPort } from './tynn-account.js';
import type { TynnAccountDump, TynnCarriedResponse } from './tynn-account-service.js';

type Call = (method: string, args: readonly unknown[]) => Promise<unknown>;
const cancelled = (): Error => Object.assign(new Error('Tynn request cancelled.'), { name: 'AbortError' });

/**
 * THE TYNN ACCOUNT AS A WINDOW SEES IT (P3.4 cut c). The sync reads answer from the host's last word; everything else is asked.
 * With no host yet it answers signed out and refuses. The browser is the one thing it does itself: the host has none to open.
 */
export class TynnAccountReplica implements TynnAccountPort {
    readonly #call: Call;
    #dump: TynnAccountDump = { status: { signedIn: false }, host: '', userId: null, savedUserId: null };
    #openExternal: ((url: string) => Promise<void>) | null = null;
    readonly #listeners = new Set<() => void>();

    constructor(call: Call) { this.#call = call; }

    useBrowser(open: (url: string) => Promise<void>): void { this.#openExternal = open; }

    rebase(dump: TynnAccountDump): void {
        const changed = JSON.stringify(dump) !== JSON.stringify(this.#dump);
        this.#dump = dump;
        if (changed) for (const listener of [...this.#listeners]) listener();
    }

    status(): TynnStatus { return this.#dump.status; }
    host(): string { return this.#dump.host; }
    userId(): string | null { return this.#dump.userId; }
    savedUserId(): string | null { return this.#dump.savedUserId; }
    onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }

    async startSignIn(): Promise<{ url: string }> {
        const started = await this.#call('startSignIn', []) as { url: string };
        try { await this.#openExternal?.(started.url); } catch { /* The visible link remains usable. */ }
        return started;
    }
    signIn(input: string): Promise<SignInResult> { return this.#call('signIn', [input]) as Promise<SignInResult>; }
    signOut(): Promise<SignOutResult> { return this.#call('signOut', []) as Promise<SignOutResult>; }
    recheck(): Promise<TynnStatus> { return this.#call('recheck', []) as Promise<TynnStatus>; }
    reload(): Promise<void> { return this.#call('reload', []) as Promise<void>; }
    projects(): Promise<unknown[]> { return this.#call('projects', []) as Promise<unknown[]>; }
    ownerOptions(): Promise<unknown[]> { return this.#call('ownerOptions', []) as Promise<unknown[]>; }
    createProject(body: { name: string; slug?: string; owner_type?: 'user' | 'organization' | 'team'; owner_id?: string }): Promise<unknown> { return this.#call('createProject', [body]); }

    /** The caller's cancel ends its wait here; the host's own deadline ends the call there. */
    async request(path: string, init: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal }): Promise<TynnResponse> {
        const { signal, ...sent } = init;
        if (signal?.aborted) throw cancelled();
        const asked = this.#call('request', [path, sent]) as Promise<TynnCarriedResponse>;
        const carried = signal
            ? await new Promise<TynnCarriedResponse>((resolve, reject) => {
                const onAbort = (): void => reject(cancelled());
                signal.addEventListener('abort', onAbort, { once: true });
                asked.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
            })
            : await asked;
        return {
            ok: carried.ok,
            status: carried.status,
            json: async () => {
                if (carried.bodyFailed) throw new Error('Tynn could not be reached. Check your connection and try again.');
                return carried.body ?? null;
            },
        };
    }
}
