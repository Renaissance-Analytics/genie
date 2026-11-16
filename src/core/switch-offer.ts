import type { AccountHeadroom } from './headroom-board.js';
import type { WindowReading } from './headroom.js';

/**
 * SWITCH OFFERS (Tynn #481, Accounts S8). The owner: when a limit is near, "a one-click switch offer, never automatic", and
 * the person chooses which windows trigger it: 5 h, weekly or both. ONE active account per provider is signed in on the host
 * and every agent of the provider uses it (Tynn #751/#753), so an offer is about the provider's ACTIVE account: when one of
 * its chosen windows is near (decision 2: 10% left, or the provider reporting it spent), the host makes ONE offer for that
 * account and window until the window resets, suggesting the other known accounts of the provider whose same window has
 * more room, best first (decision 3). Nothing switches here: a switch is the person signing in with the provider's own login.
 * Provider-enforced holds are untouched; this only decides what is offered.
 */
export type SwitchOfferWindows = '5h' | 'weekly' | 'both';
export const SWITCH_OFFER_WINDOWS_SETTING = 'switch_offer_windows' as const;
/** "Near": this share of a window left, or less (decision 2, approved 2026-11-07). */
export const SWITCH_OFFER_LEFT_PCT = 10;

const CHOICES: ReadonlySet<string> = new Set(['5h', 'weekly', 'both']);

/** The setting as stored; anything else (unset, an old value) is both. */
export function parseSwitchOfferWindows(raw: unknown): SwitchOfferWindows {
    return typeof raw === 'string' && CHOICES.has(raw) ? (raw as SwitchOfferWindows) : 'both';
}

/** A weekly window: Claude's `7d` and its model windows (`7d opus`), Codex's 10080-minute window (read `7d`). */
const isWeekly = (label: string): boolean => label === '7d' || label.startsWith('7d ');

/** Whether the choice watches the window the provider labels `label` (`5h`, `7d`, `7d opus`). */
export function offerWatches(choice: SwitchOfferWindows, label: string): boolean {
    const fiveHour = label === '5h';
    if (choice === '5h') return fiveHour;
    if (choice === 'weekly') return isWeekly(label);
    return fiveHour || isWeekly(label);
}

/** Near its limit: 10% left or less, or spent. A window past its reset (Refreshed) has its room back and is never near. */
export function nearLimit(r: WindowReading): boolean {
    return !r.refreshed && (r.over || r.leftPct <= SWITCH_OFFER_LEFT_PCT);
}

export interface KnownAccount { readonly id: string; readonly provider: string; readonly label: string }

/**
 * An account the offer suggests, and what is known of its room in the window: `reported` (its last reading, with the figure),
 * `reset` (its window has reset since that reading: its room is back) or `unknown` (no reading of this window yet: not used
 * since Genie has been counting, so its room is not known).
 */
export type TargetRoom = 'reported' | 'reset' | 'unknown';
export interface SwitchTarget {
    readonly accountId: string;
    readonly label: string;
    readonly room: TargetRoom;
    /** Only for `reported`. */
    readonly leftPct: number | null;
    readonly resetsAtMs: number | null;
}

export interface SwitchOffer {
    readonly id: string;
    readonly provider: string;
    readonly accountId: string;
    readonly label: string;
    readonly window: string;
    readonly leftPct: number;
    readonly over: boolean;
    readonly resetsAtMs: number;
    /** Accounts with room best first, then those whose room is unknown; empty = no other account to suggest (the offer says so). */
    readonly targets: readonly SwitchTarget[];
}

/**
 * WHO TO SUGGEST (decision 3): the provider's other known accounts whose SAME window has more room than the near one, and is
 * not near itself, best first; a window reset since its last reading counts as full. Then (the coordinator, 2026-11-16) the
 * accounts with no reading of that window, marked room unknown, in the book's order: a second account that has never been
 * active is exactly the one the person would switch to. One near or spent is never suggested.
 */
export function switchTargets(
    from: { provider: string; accountId: string; window: string; leftPct: number },
    readings: readonly AccountHeadroom[],
    known: readonly KnownAccount[],
): SwitchTarget[] {
    const withRoom: SwitchTarget[] = [];
    const unknown: SwitchTarget[] = [];
    for (const account of known) {
        if (account.provider !== from.provider || account.id === from.accountId) continue;
        const r = readings.find((x) => x.provider === from.provider && x.accountId === account.id)?.windows.find((w) => w.window === from.window);
        if (!r) { unknown.push({ accountId: account.id, label: account.label, room: 'unknown', leftPct: null, resetsAtMs: null }); continue; }
        if (r.refreshed) { withRoom.push({ accountId: account.id, label: account.label, room: 'reset', leftPct: null, resetsAtMs: null }); continue; }
        if (nearLimit(r) || r.leftPct <= from.leftPct) continue;
        withRoom.push({ accountId: account.id, label: account.label, room: 'reported', leftPct: r.leftPct, resetsAtMs: r.resetsAtMs });
    }
    const room = (t: SwitchTarget): number => t.leftPct ?? 101;
    return [...withRoom.sort((a, b) => room(b) - room(a) || a.label.localeCompare(b.label)), ...unknown];
}

/** What has been offered: for each `account|window`, the reset time of the window it was offered in. Plain JSON. */
export type OfferedState = Record<string, number>;

export interface SwitchOfferInput {
    readonly choice: SwitchOfferWindows;
    /** Each provider's ACTIVE account id. */
    readonly active: Readonly<Record<string, string>>;
    readonly readings: readonly AccountHeadroom[];
    readonly known: readonly KnownAccount[];
}

/** Providers re-report a reset with a little jitter; within this it is the same window (the shortest window is hours long). */
const SAME_WINDOW_MS = 10 * 60_000;

export function switchOfferId(accountId: string, window: string, resetsAtMs: number): string {
    return `switch-offer:${accountId}:${window}:${resetsAtMs}`;
}

/**
 * ONE OFFER PER ACCOUNT PER WINDOW PER RESET. The active account's chosen window, read near, is offered once; it stays
 * offered for that window however often it is read again. A window read Refreshed, or reported with a new reset time, is a
 * new window and may be offered again. Per account: one account's offer never spends another's.
 */
export class SwitchOfferWatcher {
    readonly #offered = new Map<string, number>();

    constructor(saved: OfferedState = {}) {
        if (typeof saved !== 'object' || saved === null) return;
        for (const [key, at] of Object.entries(saved)) if (typeof at === 'number' && Number.isFinite(at)) this.#offered.set(key, at);
    }

    check(input: SwitchOfferInput): SwitchOffer[] {
        const made: SwitchOffer[] = [];
        for (const account of input.readings) {
            for (const r of account.windows) {
                const key = `${account.accountId}|${r.window}`;
                if (r.refreshed) { this.#offered.delete(key); continue; }
                if (input.active[account.provider] !== account.accountId || !offerWatches(input.choice, r.window) || !nearLimit(r)) continue;
                const before = this.#offered.get(key);
                if (before !== undefined && Math.abs(before - r.resetsAtMs) < SAME_WINDOW_MS) continue;
                this.#offered.set(key, r.resetsAtMs);
                const label = input.known.find((k) => k.id === account.accountId)?.label ?? account.provider;
                made.push({
                    id: switchOfferId(account.accountId, r.window, r.resetsAtMs), provider: account.provider, accountId: account.accountId, label,
                    window: r.window, leftPct: r.leftPct, over: r.over, resetsAtMs: r.resetsAtMs,
                    targets: switchTargets({ provider: account.provider, accountId: account.accountId, window: r.window, leftPct: r.leftPct }, input.readings, input.known),
                });
            }
        }
        return made;
    }

    snapshot(): OfferedState {
        return Object.fromEntries(this.#offered);
    }
}

export interface SwitchOfferServiceOptions {
    readonly readings: () => readonly AccountHeadroom[];
    readonly known: () => readonly KnownAccount[];
    readonly active: () => Readonly<Record<string, string>>;
    /** The `switch_offer_windows` setting as stored, read at every check and every list. */
    readonly choice: () => unknown;
    readonly now?: () => number;
}

/**
 * THE HOST'S HALF: checked at each shown reading (a comparison when nothing is near), it keeps the offers still standing for
 * a window to show. An offer stands until the person says Not now, its account stops being the active one, its window
 * resets, or the window choice stops watching it. Its suggestions are read again each time it is listed, so they follow
 * the board.
 */
export class SwitchOfferService {
    readonly #o: SwitchOfferServiceOptions;
    readonly #watcher = new SwitchOfferWatcher();
    #pending: SwitchOffer[] = [];

    constructor(options: SwitchOfferServiceOptions) {
        this.#o = options;
    }

    check(): void {
        const made = this.#watcher.check({ choice: parseSwitchOfferWindows(this.#o.choice()), active: this.#o.active(), readings: this.#o.readings(), known: this.#o.known() });
        if (made.length > 0) this.#pending = [...this.#pending.filter((p) => !made.some((m) => m.id === p.id)), ...made];
    }

    offers(): SwitchOffer[] {
        const now = (this.#o.now ?? Date.now)();
        const choice = parseSwitchOfferWindows(this.#o.choice());
        const active = this.#o.active();
        this.#pending = this.#pending.filter((p) => p.resetsAtMs > now);
        const readings = this.#o.readings();
        const known = this.#o.known();
        return this.#pending
            .filter((p) => active[p.provider] === p.accountId && offerWatches(choice, p.window))
            .map((p) => ({ ...p, targets: switchTargets(p, readings, known) }));
    }

    /** Not now: the offer goes, and is not made again in that window. */
    dismiss(id: string): boolean {
        const next = this.#pending.filter((p) => p.id !== id);
        if (next.length === this.#pending.length) return false;
        this.#pending = next;
        return true;
    }
}
