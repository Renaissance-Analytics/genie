import type { AccountView } from './accounts-view.js';

/**
 * SETTINGS → PROVIDERS → ACCOUNTS (Tynn #484, Accounts S11). The person renames a known account and forgets one they no longer
 * use. Forgetting the account signed in on the host is refused, and says so: every agent of the provider uses it (Tynn #751),
 * so it is switched away from first (S9). Neither touches a credential: the book only ever held a name and what the provider
 * reported about who is signed in.
 */
export type AccountsAction =
    | { readonly kind: 'rename'; readonly id: string; readonly label: string }
    | { readonly kind: 'forget'; readonly id: string }
    /** Tynn #1011: a Claude account of its own (a configuration directory); the person then signs in to it. */
    | { readonly kind: 'add-claude'; readonly method: 'subscription' | 'console'; readonly label?: string }
    /** Tynn #1011: make it the provider's active account; every agent draws on it from its next turn, on the same thread. */
    | { readonly kind: 'set-active'; readonly id: string }
    /**
     * Switch to THIS account, by its id (the review of #2139): the host makes it active when Claude Code says it is signed in,
     * and signs it in in the browser (active once it is) only when it is not.
     */
    | { readonly kind: 'switch'; readonly id: string }
    /** Tynn #1011: sign in in the browser (prism-acp login()); never a terminal. */
    | { readonly kind: 'sign-in'; readonly id: string }
    | { readonly kind: 'cancel-sign-in'; readonly id: string }
    /** The code the CLI asked for, straight back to it; Genie keeps it nowhere. */
    | { readonly kind: 'submit-code'; readonly requestId: string; readonly code: string }
    /** Tynn #1011: prism-acp logout() for that folder, then the account and its folder go. */
    | { readonly kind: 'sign-out'; readonly id: string }
    /** Tynn #1011: a new account, signed in in the browser, active once it is. */
    | { readonly kind: 'use-another'; readonly method: 'subscription' | 'console' };

export type AccountsActResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The offer-window choice (`switch_offer_windows`, S8), as the MultiSwitch shows it. */
export const SWITCH_OFFER_WINDOW_CHOICES: ReadonlyArray<{ value: '5h' | 'weekly' | 'both'; label: string }> = [
    { value: '5h', label: '5 h' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'both', label: 'Both' },
];

/** Why an account cannot be forgotten now, or `null` when it can. The host says the same words when it refuses. */
export function forgetRefusal(account: Pick<AccountView, 'active' | 'label'>): string | null {
    return account.active ? `${account.label} is signed in. Switch to another account first, then forget it.` : null;
}

/** An action as a window sent it, checked before the host acts on it; `null` for anything else. */
export function accountsActionOf(value: unknown): AccountsAction | null {
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Record<string, unknown>;
    if (v['kind'] === 'add-claude') {
        if (v['method'] !== 'subscription' && v['method'] !== 'console') return null;
        // Only these fields are kept: anything else a window sent (a key, a token) never reaches the host.
        return typeof v['label'] === 'string' && v['label'].trim() !== '' ? { kind: 'add-claude', method: v['method'], label: v['label'] } : { kind: 'add-claude', method: v['method'] };
    }
    if (v['kind'] === 'use-another') return { kind: 'use-another', method: v['method'] === 'console' ? 'console' : 'subscription' };
    if (v['kind'] === 'submit-code') {
        // A code is one short line: anything else is not a code, and is never handed on.
        const code = typeof v['code'] === 'string' ? v['code'].trim() : '';
        if (typeof v['requestId'] !== 'string' || v['requestId'] === '' || code === '' || code.length > 512 || /[\x00-\x1f\x7f]/.test(code)) return null;
        return { kind: 'submit-code', requestId: v['requestId'], code };
    }
    if (typeof v['id'] !== 'string' || v['id'] === '') return null;
    if (v['kind'] === 'sign-in' || v['kind'] === 'cancel-sign-in' || v['kind'] === 'sign-out') return { kind: v['kind'], id: v['id'] };
    if (v['kind'] === 'set-active' || v['kind'] === 'switch') return { kind: v['kind'], id: v['id'] };
    if (v['kind'] === 'forget') return { kind: 'forget', id: v['id'] };
    if (v['kind'] === 'rename' && typeof v['label'] === 'string') return { kind: 'rename', id: v['id'], label: v['label'] };
    return null;
}
