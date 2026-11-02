import type { SignInResult, SignOutResult, TynnResponse, TynnStatus } from './tynn-account.js';
import type { TynnAccountDump } from './tynn-account-service.js';
/** RED STUB (cut c's first commit). */
export class TynnAccountReplica {
    status(): TynnStatus { return { signedIn: false }; }
    host(): string { return ''; }
    userId(): string | null { return null; }
    savedUserId(): string | null { return null; }
    onChange(_listener: () => void): () => void { return () => {}; }
    rebase(_dump: TynnAccountDump): void {}
    async signIn(_input: string): Promise<SignInResult> { return { ok: false, reason: 'not built' }; }
    async signOut(): Promise<SignOutResult> { return { ok: true, revoked: true }; }
    async startSignIn(): Promise<{ url: string }> { return { url: '' }; }
    async request(_path: string, _init: { method: string; signal?: AbortSignal }): Promise<TynnResponse> { throw new Error('not built'); }
}
