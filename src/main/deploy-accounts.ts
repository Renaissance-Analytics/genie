import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renameOverSync } from '../core/atomic-rename.js';
import type { Keychain, KeychainRead, KeychainResult, SecretName } from './keychain.js';
import type { CloudProvider } from './deploy-plan.js';

/**
 * DEPLOYMENT: THE CLOUD ACCOUNT BOOK (Tynn #871; spec .ai/plans/specs/deployment.md §3, decision D2).
 *
 * SEVERAL ACCOUNTS PER PROVIDER AT ONCE (D2). Unlike Claude accounts, a cloud account is a billing boundary: a deploy target
 * is bound to the account it lives in, and accounts are not interchangeable.
 *
 * THE TOKEN GOES ONLY TO THE OS KEYCHAIN (src/main/keychain.ts) as `deploy/<accountId>`, written and read back. The file
 * says who each account is and what it may do (provider, label, identity read from the provider, scopes, expiry, status) and
 * NEVER holds the token: only the known fields are copied into a row, so a token riding on an extra key is dropped. With no
 * keychain, connecting is refused and nothing is written (fail closed, never plain text).
 *
 * An account signed in through the provider's own login (AWS SSO, Azure device code) keeps no token in Genie at all: it uses
 * the provider's short-lived cache.
 *
 * REMOVE removes Genie's copy only; revoking the token at the provider is a separate approval item. A locked keychain on
 * remove keeps the row, because the secret is still there. A 401/403 marks the account "sign in again", never deleted.
 */

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

const ACCOUNT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const nameOf = (id: string): SecretName => `deploy/${id}`;

/** Only the known fields, so nothing else a caller put on the object (a token) is ever written. */
function row(account: CloudAccountInput, status: CloudAccount['status']): CloudAccount {
    return {
        id: account.id,
        provider: account.provider,
        label: account.label,
        identity: { id: account.identity.id, name: account.identity.name },
        authKind: account.authKind,
        scopes: [...account.scopes],
        expiresAt: account.expiresAt,
        status,
    };
}

export function cloudAccountBook(file: string, keychain: Pick<Keychain, 'get' | 'set' | 'delete'>): CloudAccountBook {
    const read = (): CloudAccount[] => {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8')) as { accounts?: unknown };
            return Array.isArray(parsed.accounts) ? (parsed.accounts as CloudAccount[]).filter((a) => a && typeof a.id === 'string' && a.identity && Array.isArray(a.scopes)).map((a) => row(a, a.status === 'sign-in-again' ? 'sign-in-again' : 'ok')) : [];
        } catch {
            return [];
        }
    };
    const write = (accounts: readonly CloudAccount[]): void => {
        mkdirSync(dirname(file), { recursive: true });
        const fresh = `${file}.tmp`;
        writeFileSync(fresh, JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
        renameOverSync(fresh, file);
    };
    const upsert = (account: CloudAccount): void => write([...read().filter((a) => a.id !== account.id), account]);

    return {
        list: read,
        connect: async (account, token) => {
            if (!ACCOUNT_ID.test(account.id)) return { ok: false, reason: 'A cloud account id is 1 to 64 letters, digits, dots, dashes or underscores.' };
            if (account.authKind === 'provider-login') {
                if (token !== undefined) return { ok: false, reason: 'An account signed in through the provider\'s own login keeps no token in Genie.' };
                upsert(row(account, 'ok'));
                return { ok: true };
            }
            if (!token) return { ok: false, reason: 'A token account needs its token.' };
            const written = await keychain.set(nameOf(account.id), token);
            if (!written.ok) return { ok: false, reason: `Genie keeps cloud tokens only in the OS keychain, and it did not keep this one, so the account was not connected: ${written.reason}` };
            const back = await keychain.get(nameOf(account.id));
            if (back.kind !== 'value' || back.value !== token) {
                return { ok: false, reason: `Genie keeps cloud tokens only in the OS keychain, and it did not read this one back, so the account was not connected${back.kind === 'unavailable' ? `: ${back.reason}` : '.'}` };
            }
            upsert(row(account, 'ok'));
            return { ok: true };
        },
        tokenFor: (id) => keychain.get(nameOf(id)),
        remove: async (id) => {
            const found = read().find((a) => a.id === id);
            if (!found) return { ok: true };
            if (found.authKind === 'token') {
                const removed = await keychain.delete(nameOf(id));
                if (!removed.ok) return removed;
            }
            write(read().filter((a) => a.id !== id));
            return { ok: true };
        },
        markSignInAgain: (id) => {
            const found = read().find((a) => a.id === id);
            if (found) upsert(row(found, 'sign-in-again'));
        },
    };
}
