/**
 * THE INBOX'S READS, over its state (the host split, P3.1). One implementation for the store that owns the mail
 * (main/inbox-store.ts, in genie-host) and the window's replica of it (main/agent-stores-replica.ts), so the two can never
 * answer differently: what the Deck counts as unread, a conversation's messages, a sender's receipts.
 */

/** What these reads need of a message (main/inbox-store.ts `InboxMessage`). */
export interface ReadableMessage {
    readonly seq: number;
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly readAt: string | null;
}

/** The mail as it is now: oldest first, and each participant's committed cursor. */
export interface MailView<M extends ReadableMessage> {
    readonly messages: readonly M[];
    readonly cursors: Readonly<Record<string, number>>;
}

export function cursorOf(mail: MailView<ReadableMessage>, participant: string): number {
    return mail.cursors[participant] ?? 0;
}

/** Mail for `participant` after `cursor`, the first `limit` of it. */
export function mailAfter<M extends ReadableMessage>(mail: MailView<M>, participant: string, cursor: number, limit?: number): M[] {
    const page = mail.messages.filter((m) => m.to === participant && m.seq > cursor);
    return limit === undefined ? page : page.slice(0, Math.max(limit, 1));
}

/** The unread mail itself, without committing anything: after the participant's own cursor. */
export function unreadOf<M extends ReadableMessage>(mail: MailView<M>, participant: string): M[] {
    return mailAfter(mail, participant, cursorOf(mail, participant));
}

/** What `from` sent, newest first, with whether each was read. */
export function receiptsOf<M extends ReadableMessage>(mail: MailView<M>, from: string, limit = 20): Array<{ message: M; readAt: string | null }> {
    return mail.messages
        .filter((m) => m.from === from)
        .slice(-Math.min(Math.max(limit, 1), 100))
        .reverse()
        .map((message) => ({ message, readAt: message.readAt }));
}

/** Whether `from` has ever sent `to` a message. What makes a reply allowed. */
export function hasWrittenIn(mail: MailView<ReadableMessage>, from: string, to: string): boolean {
    return mail.messages.some((m) => m.from === from && m.to === to);
}

/**
 * Mail to or from `participant`, oldest first, the newest `limit`, READ ONCE PER CHANGE (genie#1200): the estate snapshot
 * asks for every agent's mail many times a second while agents work. Every change to the mail either grows the array
 * (a send) or replaces it (a read, a delete, an import), so the array and its length say "unchanged".
 */
export class InvolvingCache<M extends ReadableMessage> {
    readonly #hits = new Map<string, { messages: readonly M[]; length: number; result: M[] }>();

    read(messages: readonly M[], participant: string, limit = 200): readonly M[] {
        const key = `${participant}|${limit}`;
        const hit = this.#hits.get(key);
        if (hit && hit.messages === messages && hit.length === messages.length) return hit.result;
        const result = messages.filter((m) => m.from === participant || m.to === participant).slice(-Math.max(limit, 1));
        if (this.#hits.size > 2000) this.#hits.clear();
        this.#hits.set(key, { messages, length: messages.length, result });
        return result;
    }
}
