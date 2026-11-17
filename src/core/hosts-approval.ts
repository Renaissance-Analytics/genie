import { COPY_DETAIL_OPTION, type DeckItem } from './deck.js';

/**
 * THE HOSTS FILE ASKS FIRST (Tynn #753). A site change never raises the OS prompt on its own: it records that the hosts
 * file needs a write and Genie asks here, in the person's words. Approve is the person's click and only it runs the
 * prompt (deck-resolve.ts → `sync-hosts`); Not now puts the ask away until the names change; Copy the block copies what
 * they could paste into the hosts file themselves (the item's detail), in the window.
 */
export const HOSTS_APPROVAL_DECK_ID = 'genie:hosts-approval';
export const HOSTS_APPROVE_OPTION = 'approve';
export const HOSTS_LATER_OPTION = 'later';

const and = (names: readonly string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`);

/** What the ask says: the names it adds, else the names it takes out. */
export function hostsApprovalTitle(added: readonly string[], removed: readonly string[]): string {
    if (added.length > 0) return `Genie needs administrator permission to add ${and(added)} to your hosts file so your normal browser can open ${added.length === 1 ? 'it' : 'them'}`;
    if (removed.length > 0) return `Genie needs administrator permission to take ${and(removed)} out of your hosts file`;
    return 'Genie needs administrator permission to update your hosts file';
}

export function hostsApprovalDeckItem(input: { added: readonly string[]; removed: readonly string[]; manualBlock: string; at: number }): DeckItem {
    return {
        id: HOSTS_APPROVAL_DECK_ID,
        source: 'genie',
        agentId: null,
        agentName: null,
        workspaceId: null,
        title: hostsApprovalTitle(input.added, input.removed),
        blocking: false,
        priority: 'normal',
        at: input.at,
        answer: {
            kind: 'inline',
            options: [
                { id: HOSTS_APPROVE_OPTION, label: 'Approve', tone: 'ok' },
                { id: HOSTS_LATER_OPTION, label: 'Not now', tone: 'neutral' },
                { id: COPY_DETAIL_OPTION, label: 'Copy the block', tone: 'neutral' },
            ],
        },
        forwardedFrom: null,
        why: 'Changing the hosts file needs an administrator. Genie asks your computer for that only when you click Approve; until then the site works in Genie’s browser.',
        detail: input.manualBlock,
    };
}
