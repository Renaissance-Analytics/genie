import type { AccountHeadroom } from './headroom-board.js';
import { STANDARD_WINDOWS, type WindowReading } from './headroom.js';
import type { SwitchOffer } from './switch-offer.js';

/**
 * THE ACCOUNTS A WINDOW IS SHOWN (Tynn #483, Accounts S10). One active account per provider is signed in on the host and every
 * agent of the provider uses it (Tynn #751/#753); Genie keeps each known account's last readings so the person can juggle
 * limits. Per provider: every known account, the active one first; its plan (the identity's, else the reading's, else
 * unknown: never a guess); and its windows, 5 h and weekly always (a window not reported is unknown; one past its reset reads
 * Refreshed), then any other window it reported. A provider nobody has used here (no account with an email or a reading) is
 * left out, so a provider the person never signed in to draws no chip. An account with no email, no reading and not signed
 * in (the book's placeholder after it was forgotten, Tynn #484) is not listed either: it is no account yet, only the place
 * the next sign-in takes, and would read as a blank row.
 */
export type AccountWindowRow = WindowReading | { readonly unknown: true; readonly window: string };

export interface AccountView {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    /** The provider-reported email, when known: what its own login shows, so a switch's steps name it. */
    readonly email: string | null;
    readonly plan: string | null;
    readonly active: boolean;
    readonly windows: readonly AccountWindowRow[];
}

export interface ProviderAccountsView { readonly provider: string; readonly accounts: readonly AccountView[] }

/** What `engine.accounts` answers: every provider's accounts, and the switch offers standing (S8). */
export interface AccountsSnapshot { readonly providers: readonly ProviderAccountsView[]; readonly offers: readonly SwitchOffer[] }

export interface KnownAccountRecord {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    readonly identity: { readonly email: string | null; readonly plan: string | null };
}

export function accountsView(known: readonly KnownAccountRecord[], readings: readonly AccountHeadroom[], active: Readonly<Record<string, string>>): ProviderAccountsView[] {
    const providers = [...new Set(known.map((a) => a.provider))].sort();
    const out: ProviderAccountsView[] = [];
    for (const provider of providers) {
        const mine = known.filter((a) => a.provider === provider);
        const readingOf = (id: string) => readings.find((r) => r.provider === provider && r.accountId === id);
        if (!mine.some((a) => a.identity.email !== null || readingOf(a.id) !== undefined)) continue;
        const accounts = mine.filter((a) => a.identity.email !== null || readingOf(a.id) !== undefined || active[provider] === a.id).map((a): AccountView => {
            const r = readingOf(a.id);
            const reported = r?.windows ?? [];
            const windows: AccountWindowRow[] = [
                ...STANDARD_WINDOWS.map((w): AccountWindowRow => reported.find((x) => x.window === w) ?? { unknown: true, window: w }),
                ...reported.filter((x) => !STANDARD_WINDOWS.includes(x.window)),
            ];
            return { id: a.id, provider, label: a.label, email: a.identity.email, plan: a.identity.plan ?? r?.room.plan ?? null, active: active[provider] === a.id, windows };
        });
        out.push({ provider, accounts: [...accounts.filter((a) => a.active), ...accounts.filter((a) => !a.active)] });
    }
    return out;
}

/** The words a switch's steps use for an account: its email when known (what the provider's login shows), else its label. */
export function chooseWords(account: Pick<AccountView, 'email' | 'label'>): string {
    return account.email ?? account.label;
}

/** The account the chip names: the provider's active one, or its first when the book names none. */
export function activeAccountOf(view: ProviderAccountsView): AccountView | null {
    return view.accounts.find((a) => a.active) ?? view.accounts[0] ?? null;
}
