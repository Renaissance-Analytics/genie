import type { AccountHeadroom } from './headroom-board.js';
import { STANDARD_WINDOWS, type Headroom, type WindowReading } from './headroom.js';
import type { SwitchOffer } from './switch-offer.js';
import type { DesignAuthView } from './design-auth.js';
import type { ClaudeAccountLive } from './claude-accounts.js';

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
    /** Tynn #1011: a Claude account with a configuration directory of its own (switched with one click, no terminal). */
    readonly ownDirectory?: boolean;
    /** Tynn #1011: what the person chose to sign in with there. */
    readonly method?: 'subscription' | 'console';
    /** Tynn #1011: what Claude Code reports for it now (prism-acp `describe` + `compare`); absent = not known now. */
    readonly live?: ClaudeAccountLive;
}

export interface ProviderAccountsView { readonly provider: string; readonly accounts: readonly AccountView[] }

/** What `engine.accounts` answers: every provider's accounts, and the switch offers standing (S8). */
export interface AccountsSnapshot {
    readonly providers: readonly ProviderAccountsView[];
    readonly offers: readonly SwitchOffer[];
    /** Claude Design's authorization, one for the machine (Tynn #480); absent from an older host. */
    readonly design?: DesignAuthView | undefined;
}

export interface KnownAccountRecord {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    readonly identity: { readonly email: string | null; readonly plan: string | null };
    readonly configDir?: string;
    readonly method?: 'subscription' | 'console';
}

export function accountsView(known: readonly KnownAccountRecord[], readings: readonly AccountHeadroom[], active: Readonly<Record<string, string>>, live: Readonly<Record<string, ClaudeAccountLive>> = {}): ProviderAccountsView[] {
    const providers = [...new Set(known.map((a) => a.provider))].sort();
    const out: ProviderAccountsView[] = [];
    for (const provider of providers) {
        const mine = known.filter((a) => a.provider === provider);
        const readingOf = (id: string) => readings.find((r) => r.provider === provider && r.accountId === id);
        // An account the person added with its own directory (Tynn #1011) is listed from the start: it is waiting for its sign-in.
        const listed = (a: KnownAccountRecord) => a.identity.email !== null || readingOf(a.id) !== undefined || a.configDir !== undefined;
        if (!mine.some(listed)) continue;
        const accounts = mine.filter((a) => listed(a) || active[provider] === a.id).map((a): AccountView => {
            const r = readingOf(a.id);
            const reported = r?.windows ?? [];
            const windows: AccountWindowRow[] = [
                ...STANDARD_WINDOWS.map((w): AccountWindowRow => reported.find((x) => x.window === w) ?? { unknown: true, window: w }),
                ...reported.filter((x) => !STANDARD_WINDOWS.includes(x.window)),
            ];
            const own = a.configDir !== undefined ? { ownDirectory: true as const, ...(a.method ? { method: a.method } : {}) } : {};
            return { id: a.id, provider, label: a.label, email: a.identity.email, plan: a.identity.plan ?? r?.room.plan ?? null, active: active[provider] === a.id, windows, ...own, ...(live[a.id] ? { live: live[a.id]! } : {}) };
        });
        out.push({ provider, accounts: [...accounts.filter((a) => a.active), ...accounts.filter((a) => !a.active)] });
    }
    return out;
}

/** The words a switch's steps use for an account: its email when known (what the provider's login shows), else its label. */
export function chooseWords(account: Pick<AccountView, 'email' | 'label'>): string {
    return account.email ?? account.label;
}

/**
 * WHAT THE HEADER WARNS ABOUT, ONE PER PROVIDER (Tynn #753): a provider with accounts reads its ACTIVE account's figures only —
 * never the provider's latest reading, which after a sign-in can be the previous account's. A window the active account has not
 * reported, or one past its reset, carries no figure; an active account with none leaves the provider out (unknown). A
 * provider without accounts keeps the feed's reading.
 */
export function headerLimits(limits: Readonly<Record<string, Headroom>>, accounts: AccountsSnapshot | undefined): Readonly<Record<string, Headroom>> {
    const out: Record<string, Headroom> = {};
    const providers = new Set([...Object.keys(limits), ...(accounts?.providers.map((v) => v.provider) ?? [])]);
    for (const provider of providers) {
        const view = accounts?.providers.find((v) => v.provider === provider);
        if (!view) { if (limits[provider]) out[provider] = limits[provider]!; continue; }
        const active = activeAccountOf(view);
        const windows = (active?.windows ?? []).flatMap((w) => ('unknown' in w || w.refreshed ? [] : [{ window: w.window, usedPct: 100 - w.leftPct, leftPct: w.leftPct, resetsAtMs: w.resetsAtMs, over: w.over }]));
        if (windows.length === 0) continue;
        const first = windows[0]!;
        out[provider] = { plan: active?.plan ?? null, window: first.window, leftPct: first.leftPct, resetsAtMs: first.resetsAtMs, over: first.over, windows };
    }
    return out;
}

/** The account the chip names: the provider's active one, or its first when the book names none. */
export function activeAccountOf(view: ProviderAccountsView): AccountView | null {
    return view.accounts.find((a) => a.active) ?? view.accounts[0] ?? null;
}
