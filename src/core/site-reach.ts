import type { DeckItem } from './deck.js';
import { trustDeckItem } from './gen-ca.js';
import { hostsApprovalDeckItem } from './hosts-approval.js';

/** RED STUB (Tynn #743): the names the test reads; the behaviour is still the two separate asks. */
export const SITE_REACH_DECK_PREFIX = 'genie:open-in-browser:';
export const SITE_REACH_OPEN_OPTION = 'open';
export const SITE_REACH_LATER_OPTION = 'later';

export interface HostsAsk {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly manualBlock: string;
    readonly at: number;
}

export interface ReachInput {
    readonly trust: { trusted: boolean | null; sites: number; host: string | null; deferredFor: string | null; thumbprint: string; at: number };
    readonly hosts: HostsAsk | null;
}

export function reachDeckItems(input: ReachInput): DeckItem[] {
    const trust = trustDeckItem(input.trust);
    return [...(trust ? [trust] : []), ...(input.hosts ? [hostsApprovalDeckItem(input.hosts)] : [])];
}
