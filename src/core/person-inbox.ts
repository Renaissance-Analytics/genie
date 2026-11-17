import { HUMAN, pairKey, type ThreadMail } from './inbox-threads.js';

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
export function isPersonInbox(value: string | null | undefined): boolean {
    return value === PERSON_INBOX;
}

const PREVIEW_CHARS = 140;
const preview = (text: string): string => {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS - 1)}…` : one;
};

/** Mail to the person from someone else: the person's inbox holds nothing else. */
const forThePerson = (m: ThreadMail): boolean => m.to === HUMAN && m.from !== HUMAN;
const sentAt = (m: ThreadMail): number => {
    const t = Date.parse(m.sentAt);
    return Number.isNaN(t) ? -Infinity : t;
};

/** The mail addressed to the person, newest first, each message once (the snapshot's unread and recent overlap). */
export function personItems(mail: readonly ThreadMail[], name: (participant: string) => string, limit: number = PERSON_INBOX_MAX): PersonItem[] {
    const byId = new Map<string, ThreadMail>();
    for (const m of mail) if (forThePerson(m)) byId.set(m.id, m);
    return [...byId.values()]
        .sort((x, y) => sentAt(y) - sentAt(x) || y.seq - x.seq)
        .slice(0, Math.max(0, limit))
        .map((m): PersonItem => ({
            id: m.id,
            seq: m.seq,
            from: m.from,
            fromName: m.app?.label ?? name(m.from),
            kind: m.app || m.from.startsWith('app:') ? 'app' : 'agent',
            text: m.text,
            preview: preview(m.text),
            at: sentAt(m),
            unread: m.readAt === null,
            threadKey: pairKey(m.from, m.to),
            ...(m.app ? { subject: m.app.subject, level: m.app.level, ...(m.app.link ? { link: m.app.link } : {}) } : {}),
        }));
}

/** How much of it the person has not read. */
export function personUnread(mail: readonly ThreadMail[]): number {
    const ids = new Set<string>();
    for (const m of mail) if (forThePerson(m) && m.readAt === null) ids.add(m.id);
    return ids.size;
}
