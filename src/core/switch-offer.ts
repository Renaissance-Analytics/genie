import type { AccountHeadroom } from './headroom-board.js';
import type { WindowReading } from './headroom.js';

/** ACCOUNTS S8 (Tynn #481): RED stub. Every export answers "nothing to offer". */
export type SwitchOfferWindows = '5h' | 'weekly' | 'both';
export const SWITCH_OFFER_WINDOWS_SETTING = 'switch_offer_windows' as const;
export const SWITCH_OFFER_LEFT_PCT = 10;

export interface KnownAccount { readonly id: string; readonly provider: string; readonly label: string }
export interface SwitchTarget { readonly accountId: string; readonly label: string; readonly leftPct: number | null; readonly resetsAtMs: number | null }
export interface SwitchOffer {
    readonly id: string; readonly provider: string; readonly accountId: string; readonly label: string;
    readonly window: string; readonly leftPct: number; readonly over: boolean; readonly resetsAtMs: number;
    readonly targets: readonly SwitchTarget[];
}
export type OfferedState = Record<string, number>;
export interface SwitchOfferInput {
    readonly choice: SwitchOfferWindows;
    readonly active: Readonly<Record<string, string>>;
    readonly readings: readonly AccountHeadroom[];
    readonly known: readonly KnownAccount[];
}

export function parseSwitchOfferWindows(_raw: unknown): SwitchOfferWindows { return 'both'; }
export function offerWatches(_choice: SwitchOfferWindows, _label: string): boolean { return false; }
export function nearLimit(_r: WindowReading): boolean { return false; }
export function switchTargets(_from: { provider: string; accountId: string; window: string; leftPct: number }, _readings: readonly AccountHeadroom[], _known: readonly KnownAccount[]): SwitchTarget[] { return []; }

export class SwitchOfferWatcher {
    constructor(_saved: OfferedState = {}) {}
    check(_input: SwitchOfferInput): SwitchOffer[] { return []; }
    snapshot(): OfferedState { return {}; }
}

export interface SwitchOfferServiceOptions {
    readonly readings: () => readonly AccountHeadroom[];
    readonly known: () => readonly KnownAccount[];
    readonly active: () => Readonly<Record<string, string>>;
    readonly choice: () => unknown;
    readonly now?: () => number;
}

export class SwitchOfferService {
    constructor(_options: SwitchOfferServiceOptions) {}
    check(): void {}
    offers(): SwitchOffer[] { return []; }
    dismiss(_id: string): boolean { return false; }
}
