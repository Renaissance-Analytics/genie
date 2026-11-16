import type { AccountHeadroom } from './headroom-board.js';
import type { WindowReading } from './headroom.js';
import type { SwitchOffer } from './switch-offer.js';

/** ACCOUNTS S10 (Tynn #483): RED stub. */
export type AccountWindowRow = WindowReading | { readonly unknown: true; readonly window: string };
export interface AccountView {
    readonly id: string; readonly provider: string; readonly label: string; readonly plan: string | null; readonly active: boolean;
    readonly windows: readonly AccountWindowRow[];
}
export interface ProviderAccountsView { readonly provider: string; readonly accounts: readonly AccountView[] }
export interface AccountsSnapshot { readonly providers: readonly ProviderAccountsView[]; readonly offers: readonly SwitchOffer[] }
export interface KnownAccountRecord {
    readonly id: string; readonly provider: string; readonly label: string;
    readonly identity: { readonly email: string | null; readonly plan: string | null };
}

export function accountsView(_known: readonly KnownAccountRecord[], _readings: readonly AccountHeadroom[], _active: Readonly<Record<string, string>>): ProviderAccountsView[] {
    return [];
}
