import type { AccountHeadroom } from './headroom-board.js';
import type { Headroom, WindowReading } from './headroom.js';
import type { SwitchOffer } from './switch-offer.js';
import type { DesignAuthView } from './design-auth.js';
import type { ClaudeAccountLive } from './claude-accounts.js';
import type { UsageProbeState } from './usage-probe.js';

/**
 * THE ACCOUNTS A WINDOW IS SHOWN (Tynn #483, Accounts S10). One active account per provider is signed in on the host and every
 * agent of the provider uses it (Tynn #751/#753); Genie keeps each known account's last readings so the person can juggle
 * limits. Per provider: every known account, the active one first; its plan (the identity's, else the reading's, else
 * unknown: never a guess); and its windows, EXACTLY the ones ITS OWN readings reported, in the provider's order (Tynn #1070:
 * accounts are not one shape; one has no 5 h window, another a per-model weekly cap), one past its reset reading Refreshed. An
 * account never read has no windows and `read: false`: its usage is unknown, never another account's. A provider nobody has used here (no account with an email or a reading) is
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
    /** Tynn #1070: whether any reading of THIS account is known. `false`: its usage is unknown (and `windows` is empty). */
    readonly read: boolean;
    /** The windows this account's own readings reported, and only those (Tynn #1070). */
    readonly windows: readonly AccountWindowRow[];
    /** Tynn #1011: a Claude account with a configuration directory of its own (switched with one click, no terminal). */
    readonly ownDirectory?: boolean;
    /** Tynn #1011: what the person chose to sign in with there. */
    readonly method?: 'subscription' | 'console';
    /** Tynn #1011: what Claude Code reports for it now (prism-acp `describe` + `compare`); absent = not known now. */
    readonly live?: ClaudeAccountLive;
    /** Tynn #1084: its usage is being read now, or why the last read failed. Absent: nothing to say. */
    readonly usage?: UsageProbeState;
}

/** Tynn #1084: running agents of a provider still on another account than its active one, until each is idle. */
export interface StillOnAccount {
    readonly accountId: string;
    readonly label: string;
    readonly count: number;
    /** It cannot move to the active account: why, in plain words (Restart then starts it fresh, a new conversation). */
    readonly stays?: string;
}

export interface ProviderAccountsView {
    /** Tynn #1089: the active account ran out while an agent waits on it — the line beside the chip, and its `Switch to`. */
    readonly activeOut?: import('./active-out.js').ActiveOutView;
    readonly provider: string;
    readonly accounts: readonly AccountView[];
    /** Tynn #1084: agents still on another account than the active one; absent or empty = every agent is on it. */
    readonly stillOn?: readonly StillOnAccount[];
}

/** What the host adds to the book (Tynn #1084): each account's usage read, and the agents not yet on the active account. */
export interface AccountsViewExtras {
    readonly usage?: Readonly<Record<string, UsageProbeState>>;
    readonly stillOn?: Readonly<Record<string, readonly StillOnAccount[]>>;
}

/** What `engine.accounts` answers: every provider's accounts, and the switch offers standing (S8). */
export interface AccountsSnapshot {
    readonly providers: readonly ProviderAccountsView[];
    readonly offers: readonly SwitchOffer[];
    /** The Claude sign-ins running now (Tynn #1011): in the browser, or waiting for a code the CLI asked for. Never a code. */
    readonly signIns?: readonly import('./claude-accounts.js').ClaudeSignInView[] | undefined;
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

export function accountsView(known: readonly KnownAccountRecord[], readings: readonly AccountHeadroom[], active: Readonly<Record<string, string>>, live: Readonly<Record<string, ClaudeAccountLive>> = {}, extras: AccountsViewExtras = {}): ProviderAccountsView[] {
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
            const windows: AccountWindowRow[] = [...(r?.windows ?? [])];
            const own = a.configDir !== undefined ? { ownDirectory: true as const, ...(a.method ? { method: a.method } : {}) } : {};
            return { id: a.id, provider, label: a.label, email: a.identity.email, plan: a.identity.plan ?? r?.room.plan ?? null, active: active[provider] === a.id, read: r !== undefined, windows, ...own, ...(live[a.id] ? { live: live[a.id]! } : {}), ...(extras.usage?.[a.id] ? { usage: extras.usage[a.id]! } : {}) };
        });
        const stillOn = (extras.stillOn?.[provider] ?? []).filter((s) => s.count > 0 && s.accountId !== active[provider]);
        out.push({ provider, accounts: [...accounts.filter((a) => a.active), ...accounts.filter((a) => !a.active)], ...(stillOn.length > 0 ? { stillOn } : {}) });
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
