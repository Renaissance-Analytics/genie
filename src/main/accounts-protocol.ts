import { accountsActionOf, type AccountsAction, type AccountsActResult } from '../core/account-settings.js';
import type { AccountsSnapshot } from '../core/accounts-view.js';
import { ACCOUNTS_METHODS, type AccountsMethod, type CallContext, type RemoteMethod } from '../core/remote-protocol.js';

export { ACCOUNTS_METHODS, type AccountsMethod };

/**
 * THE ACCOUNT CHIPS ON THE ONE PROTOCOL (client/host split step 2a, Tynn #895; P4 #332).
 *
 * Every known provider account with its readings and the standing switch offers (Tynn #483), renaming or forgetting one
 * (Tynn #484), and Not now on an offer (Tynn #481). The host owns the account book; a client only shows it. So these are
 * protocol methods like any other, answered the same way for this machine's window, a paired device and a phone. A
 * share-link guest is refused them (remote-host.ts OWNER_ONLY): they are the host owner's accounts.
 *
 * One answer function, used by both servers: `buildHostApi` (host-api.ts) and genie-host's own answers
 * (`accountsOwnAnswers`, remote-access-host.ts `own`), so the checks live in one place.
 */

/** What a host holds of its accounts. */
export interface AccountsPort {
    /** Every known account and the standing offers; `null` while the host cannot say. */
    list(): Promise<AccountsSnapshot | null> | AccountsSnapshot | null;
    act(action: AccountsAction, context?: CallContext): Promise<AccountsActResult> | AccountsActResult;
    /** Not now on one offer: `true` when it was standing and has gone. */
    dismissOffer(id: string): Promise<boolean> | boolean;
}

export const NOT_AN_ACCOUNT_ACTION = 'That is not an account action.';
export const ACCOUNTS_NOT_READY = 'The accounts are not ready on this host yet.';

export function isAccountsMethod(method: string): method is AccountsMethod {
    return (ACCOUNTS_METHODS as readonly string[]).includes(method);
}

/** One accounts call, checked. A host without accounts answers `null`, a refusal in words, and `false`. */
export async function answerAccounts(port: AccountsPort | undefined, method: AccountsMethod, args: readonly unknown[], context?: CallContext): Promise<unknown> {
    switch (method) {
        case 'accounts.list':
            return port ? (await port.list()) ?? null : null;
        case 'accounts.act': {
            const action = accountsActionOf(args[0]);
            if (!action) return { ok: false, reason: NOT_AN_ACCOUNT_ACTION } satisfies AccountsActResult;
            if (!port) return { ok: false, reason: ACCOUNTS_NOT_READY } satisfies AccountsActResult;
            return port.act(action, context);
        }
        case 'accounts.dismissOffer':
            return typeof args[0] === 'string' && args[0] !== '' && port ? (await port.dismissOffer(args[0])) === true : false;
    }
}

/**
 * genie-host's own answers for the family: it performs them itself, whether or not a window is connected. A getter while
 * the book is still being composed: until then the answers are those of a host with no accounts, never a throw.
 */
export function accountsOwnAnswers(port: AccountsPort | (() => AccountsPort | null)): Partial<Record<RemoteMethod, (args: unknown[], context?: CallContext) => Promise<unknown>>> {
    const now = (): AccountsPort | undefined => (typeof port === 'function' ? port() ?? undefined : port);
    return Object.fromEntries(ACCOUNTS_METHODS.map((method) => [method, (args: unknown[], context?: CallContext) => answerAccounts(now(), method, args, context)]));
}
