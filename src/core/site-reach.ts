import { COPY_DETAIL_OPTION, type DeckItem } from './deck.js';
import { trustDeckItem } from './gen-ca.js';
import { hostsApprovalDeckItem } from './hosts-approval.js';

/**
 * OPEN <NAME> IN YOUR BROWSER (Tynn #743). Making a site reachable from the person's normal browser used to be two Genie
 * rows for one goal — "Trust Genie's certificate…" and (since #753) "Genie needs administrator permission to add … to
 * your hosts file…" — each its own OS prompt, neither saying "open your site", the why never drawn, and nothing opened
 * the site once it was approved. A client on the LiftPoint onboarding (2026-11-16) needed nine steps and the owner's
 * help to get there.
 *
 * Now it is ONE row, in the person's words: "Open shop.gen in your browser". Its why says in place that the computer
 * asks once, and what for. Open in browser runs everything due in ONE prompt — the Trust carries a due hosts write in
 * the same prompt (HostsSync.joinElevation) — and then the site opens in the person's normal browser (deck-answer.ts).
 *
 * The id carries the name the row opens (`genie:open-in-browser:<host>`), so the answer needs nothing but the item.
 * A hosts change that only REMOVES names is not about opening anything: it keeps #753's hosts-file ask.
 */
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
    /** As gen-ca.ts trustDeckItem reads it: the row is due when the store said untrusted, a site exists and no Not now. */
    readonly trust: { trusted: boolean | null; sites: number; host: string | null; deferredFor: string | null; thumbprint: string; at: number };
    /** The hosts write waiting for the person (HostsSync.ask), or null. */
    readonly hosts: HostsAsk | null;
}

const and = (names: readonly string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`);

/** The URL a reach row opens, from its id; null for any other item. */
export function siteReachUrl(itemId: string): string | null {
    if (!itemId.startsWith(SITE_REACH_DECK_PREFIX)) return null;
    const host = itemId.slice(SITE_REACH_DECK_PREFIX.length);
    return /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : null;
}

/** Genie's asks about reaching sites from the normal browser: one row, the removal-only hosts ask, or none. */
export function reachDeckItems(input: ReachInput): DeckItem[] {
    const trustDue = trustDeckItem(input.trust) !== null;
    const hosts = input.hosts;
    const adding = hosts !== null && hosts.added.length > 0;
    if (!trustDue && !adding) return hosts ? [hostsApprovalDeckItem(hosts)] : [];
    const names = adding ? hosts.added : [input.trust.host ?? '<name>.gen'];
    const what = [adding ? `adds ${and(names)} to your hosts file` : null, trustDue ? 'trusts its own certificate' : null].filter((w) => w !== null).join(' and ');
    return [{
        id: `${SITE_REACH_DECK_PREFIX}${names[0]}`,
        source: 'genie',
        agentId: null,
        agentName: null,
        workspaceId: null,
        title: `Open ${and(names)} in your browser`,
        blocking: false,
        priority: 'normal',
        at: hosts?.at ?? input.trust.at,
        answer: {
            kind: 'inline',
            options: [
                { id: SITE_REACH_OPEN_OPTION, label: 'Open in browser', tone: 'ok' },
                { id: SITE_REACH_LATER_OPTION, label: 'Not now', tone: 'neutral' },
                ...(hosts ? [{ id: COPY_DETAIL_OPTION, label: 'Copy the block', tone: 'neutral' as const }] : []),
            ],
        },
        forwardedFrom: null,
        why: `Your computer asks once for administrator permission: Genie ${what}. Until then the site works in Genie’s browser.`,
        ...(hosts ? { detail: hosts.manualBlock } : {}),
    }];
}
