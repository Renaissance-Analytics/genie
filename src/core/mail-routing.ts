import type { Inbox } from './mail.js';

/**
 * GENIE MAIL'S ROUTING (Tynn #383, story G4 #490; spec .ai/plans/specs/genie-mail.md): which inbox a message belongs to,
 * decided by the HOST from facts it can vouch for. A missing or wrong Mailpit tag must never move mail across
 * workspaces, so tags never route.
 *
 *   - RECEIVED: the message was addressed to the inbox: To, Cc or Bcc (Mailpit puts a recipient that is only on the
 *     envelope in Bcc; measured in test/mailpit-measure/mail-g4-routing.accept.ts), compared case-insensitively.
 *   - SENT: the inbox's SMTP user sent it, which Mailpit records as the message's Username. G1's finding 6
 *     (genie#1712): Mailpit records the send API's Basic user there too, UNVERIFIED unless the send API has its own
 *     credential. So a Username counts only on a source whose send API is closed (Genie's shared Mailpit, G2), where it
 *     can come from authenticated SMTP alone. On any other source it counts for nothing.
 *   - A Username that is not an inbox's SMTP user (Genie's own send-API user, anyone else) routes nowhere.
 */

/** A Mailpit message summary, as much of it as routing reads. */
export interface MailSummary {
    readonly ID: string;
    readonly From?: { readonly Address: string; readonly Name?: string } | null;
    readonly To: ReadonlyArray<{ readonly Address: string; readonly Name?: string }>;
    readonly Cc: ReadonlyArray<{ readonly Address: string; readonly Name?: string }>;
    readonly Bcc: ReadonlyArray<{ readonly Address: string; readonly Name?: string }>;
    readonly Username?: string;
    readonly Tags?: readonly string[];
}

/** Where a message was read. `sendApiClosed`: its Username can only have come from authenticated SMTP. */
export interface MailSource {
    readonly id: string;
    readonly sendApiClosed: boolean;
}

const norm = (address: string) => address.trim().toLowerCase();

/** The inboxes a message was received by and sent by, in the book's order. */
export function routeMessage(message: MailSummary, inboxes: readonly Inbox[], source: MailSource): { received: string[]; sent: string[] } {
    const recipients = new Set([...(message.To ?? []), ...(message.Cc ?? []), ...(message.Bcc ?? [])].map((a) => norm(a.Address)));
    const username = source.sendApiClosed && typeof message.Username === 'string' ? norm(message.Username) : '';
    return {
        received: inboxes.filter((i) => recipients.has(norm(i.address))).map((i) => i.id),
        sent: username === '' ? [] : inboxes.filter((i) => norm(i.smtpUser) === username).map((i) => i.id),
    };
}

/** The messages that belong to a workspace: those routed to one of ITS inboxes, received or sent. Nothing else. */
export function messagesForWorkspace<M extends MailSummary>(workspaceId: string, messages: readonly M[], inboxes: readonly Inbox[], source: MailSource): M[] {
    const mine = inboxes.filter((i) => i.workspaceId === workspaceId);
    if (mine.length === 0) return [];
    return messages.filter((m) => {
        const route = routeMessage(m, mine, source);
        return route.received.length > 0 || route.sent.length > 0;
    });
}
