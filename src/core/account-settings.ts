import type { AccountView } from './accounts-view.js';

/** ACCOUNTS S11 (Tynn #484): RED stub. */
export type AccountsAction = { readonly kind: 'rename'; readonly id: string; readonly label: string } | { readonly kind: 'forget'; readonly id: string };
export type AccountsActResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export const SWITCH_OFFER_WINDOW_CHOICES: ReadonlyArray<{ value: string; label: string }> = [];
export function forgetRefusal(_account: Pick<AccountView, 'active' | 'label'>): string | null { return null; }
