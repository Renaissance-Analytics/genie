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
    | { readonly kind: 'set-active'; readonly id: string };

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
    if (typeof v['id'] !== 'string' || v['id'] === '') return null;
    if (v['kind'] === 'set-active') return { kind: 'set-active', id: v['id'] };
    if (v['kind'] === 'forget') return { kind: 'forget', id: v['id'] };
    if (v['kind'] === 'rename' && typeof v['label'] === 'string') return { kind: 'rename', id: v['id'], label: v['label'] };
    return null;
}
