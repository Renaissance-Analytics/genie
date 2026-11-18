import type { Keychain, KeychainRead, KeychainResult } from './keychain.js';
import type { CloudProvider } from './deploy-plan.js';

/** DEPLOYMENT: THE CLOUD ACCOUNT BOOK (Tynn #871; spec §3, D2). RED stub: types only. */

export interface CloudAccountInput {
    readonly id: string;
    readonly provider: CloudProvider;
    readonly label: string;
    readonly identity: { readonly id: string; readonly name: string };
    readonly authKind: 'token' | 'provider-login';
    readonly scopes: readonly string[];
    readonly expiresAt: string | null;
}

export interface CloudAccount extends CloudAccountInput {
    readonly status: 'ok' | 'sign-in-again';
}

export interface CloudAccountBook {
    list(): CloudAccount[];
    connect(account: CloudAccountInput, token?: string): Promise<KeychainResult>;
    tokenFor(id: string): Promise<KeychainRead>;
    remove(id: string): Promise<KeychainResult>;
    markSignInAgain(id: string): void;
}

export function cloudAccountBook(_file: string, _keychain: Pick<Keychain, 'get' | 'set' | 'delete'>): CloudAccountBook {
    const no = (): never => { throw new Error('not built yet (#871 RED)'); };
    return { list: no, connect: no, tokenFor: no, remove: no, markSignInAgain: no };
}
