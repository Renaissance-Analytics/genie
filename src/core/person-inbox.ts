import type { ThreadMail } from './inbox-threads.js';

/**
 * THE PERSON'S INBOX (Tynn #742; the owner, LiftPoint onboarding 2026-11-16: "There's going to be a user inbox that's
 * coming, on the left-hand side, so things that are specific to you [are separate], because right now it kind of gets
 * lost in with the other agent stuff … when you've got eight agents working all talking to each other").
 *
 * Not a second mail system: it is the AgentInbox's own mail (main/inbox-store.ts), read for ONE reader. What is in it is
 * mail addressed TO the person — an agent's, an app's (genie#1345; genie#1415 delivers app notices to the person into
 * this same mail) — and nothing else: no agent-to-agent mail, and not what the person sent.
 */

/** The `inbox=` route value (core/route.ts) that opens the person's inbox instead of the AgentInbox's threads. */
export const PERSON_INBOX = 'you';

/** How many items the list holds; older mail is in the AgentInbox. */
export const PERSON_INBOX_MAX = 200;

export interface PersonItem {
    readonly id: string;
    readonly seq: number;
    readonly from: string;
    readonly fromName: string;
    readonly kind: 'agent' | 'app';
    /** The whole text, drawn when the item is open. */
    readonly text: string;
    /** One line of it, for the list. */
    readonly preview: string;
    /** Epoch ms it was sent. */
    readonly at: number;
    readonly unread: boolean;
    /** Its conversation in the AgentInbox (`pairKey`): where a reply is written. */
    readonly threadKey: string;
    /** An app's subject, level and link back into it (genie#1345), when it carries them. */
    readonly subject?: string | undefined;
    readonly level?: 'info' | 'success' | 'failure' | undefined;
    readonly link?: string | undefined;
}

/** Is this `inbox=` value the person's inbox? */
export function isPersonInbox(_value: string | null | undefined): boolean {
    return false;
}

/** The mail addressed to the person, newest first, each message once (the snapshot's unread and recent overlap). */
export function personItems(_mail: readonly ThreadMail[], _name: (participant: string) => string, _limit: number = PERSON_INBOX_MAX): PersonItem[] {
    return [];
}

/** How much of it the person has not read. */
export function personUnread(_mail: readonly ThreadMail[]): number {
    return 0;
}
