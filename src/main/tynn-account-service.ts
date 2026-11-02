import type { TynnAccount, TynnStatus } from './tynn-account.js';
export interface TynnAccountDump { readonly status: TynnStatus; readonly host: string; readonly userId: string | null; readonly savedUserId: string | null }
/** RED STUB (cut c's first commit). */
export class TynnAccountService {
    constructor(readonly account: TynnAccount) {}
    dump(): TynnAccountDump { return { status: { signedIn: false }, host: '', userId: null, savedUserId: null }; }
    call(_method: string, _args: readonly unknown[]): Promise<unknown> { return Promise.reject(new Error('not built')); }
    onEvent(_listener: (dump: TynnAccountDump) => void): void {}
}
