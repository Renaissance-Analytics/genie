import type { TynnAccount, TynnStatus } from './tynn-account.js';

/**
 * THE HOST'S TYNN ACCOUNT, AS A WINDOW ASKS IT (P3.4 cut c). What crosses the link is who is signed in and what Tynn answered,
 * and never the pairing token: there is no method that returns it, and an unlisted method is refused.
 */
export interface TynnAccountDump {
    readonly status: TynnStatus;
    readonly host: string;
    readonly userId: string | null;
    readonly savedUserId: string | null;
}
/** A response, carried: `bodyFailed` is a body that could not be read, which `json()` must still reject on the far side. */
export interface TynnCarriedResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly body?: unknown;
    readonly bodyFailed?: true;
}
type RequestInit = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown };

export class TynnAccountService {
    #account: TynnAccount | null = null;
    readonly #opening: Promise<TynnAccount>;
    readonly #host: string;
    readonly #listeners = new Set<(dump: TynnAccountDump) => void>();

    /**
     * An account still opening is fine: opening asks Tynn who it is, with a 30 s deadline, and a host's boot does not wait for
     * that. Until it opens, a window reads signed out and its calls wait; then it hears the change.
     */
    constructor(account: TynnAccount | Promise<TynnAccount>, options: { host?: string } = {}) {
        this.#host = options.host ?? '';
        const emit = (): void => { const dump = this.dump(); for (const listener of [...this.#listeners]) listener(dump); };
        const adopt = (opened: TynnAccount): TynnAccount => { this.#account = opened; opened.onChange(emit); emit(); return opened; };
        if (account instanceof Promise) this.#opening = account.then(adopt);
        else { this.#opening = Promise.resolve(adopt(account)); }
        void this.#opening.catch(() => {});
    }

    dump(): TynnAccountDump {
        const account = this.#account;
        if (!account) return { status: { signedIn: false }, host: this.#host, userId: null, savedUserId: null };
        return { status: account.status(), host: account.host(), userId: account.userId(), savedUserId: account.savedUserId() };
    }

    onEvent(listener: (dump: TynnAccountDump) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        const account = await this.#opening;
        switch (method) {
            case 'startSignIn': return account.startSignIn();
            case 'signIn': return account.signIn(String(args[0] ?? ''));
            case 'signOut': return account.signOut();
            case 'recheck': return account.recheck();
            case 'reload': return account.reload();
            case 'projects': return account.projects();
            case 'ownerOptions': return account.ownerOptions();
            case 'createProject': return account.createProject(args[0] as Parameters<TynnAccount['createProject']>[0]);
            case 'request': {
                const res = await account.request(String(args[0] ?? ''), args[1] as RequestInit);
                const carried: TynnCarriedResponse = await res.json().then(
                    (body) => ({ ok: res.ok, status: res.status, body }),
                    () => ({ ok: res.ok, status: res.status, bodyFailed: true as const }),
                );
                return carried;
            }
            default:
                throw new Error(`The Tynn account has no ${method}.`);
        }
    }
}
