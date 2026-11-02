import { isAppSender } from '../core/app-inbox.js';
import { HUMAN } from '../core/inbox.js';
import type { ReminderBook } from '../core/inbox-reminders.js';
import type { NoticeMail } from '../core/stream-event.js';
import type { InboxMessage } from './inbox-store.js';

/** How much of each message a notice's row keeps: enough to read it in the chat; the whole message stays in the inbox. */
export const NOTICE_MAIL_CHARS = 4_000;

/**
 * THE NOTICES DUE NOW (the inbox push's "reminders"): for each agent with a run and unread mail the reminder book has not
 * told it about, the notice's text and the mail it is about. One implementation for genie-host's mail wake (P3.2) and the
 * window's own on the emergency path (compose.ts).
 */
export function inboxNotices(input: {
    readonly agents: ReadonlyMap<string, { readonly name: string }>;
    readonly unread: (agentId: string) => readonly InboxMessage[];
    readonly reminders: ReminderBook;
    readonly run: (agentId: string) => number | null;
}): Array<{ agentId: string; text: string; mail: readonly NoticeMail[] }> {
    return [...input.agents.keys()].flatMap((id) => {
        // No run, no notice (`reminders.due` answers null for it): its mail is not read on every session event.
        const runNow = input.run(id);
        if (runNow === null) return [];
        const unread = input.unread(id);
        // How many came from APPS (genie#1345): the notice says so, and nothing of what they say.
        const fromApps = unread.filter((m) => isAppSender(m.from)).length;
        const text = input.reminders.due({ agentId: id, unread: unread.length, newestSeq: unread.at(-1)?.seq ?? 0, run: runNow, fromApps });
        if (!text) return [];
        // WHAT THE NOTICE IS ABOUT (beta.33 item 18): each unread message, who from and what it says, carried on the notice's
        // row so the chat shows the context — the prompt itself stays the short instruction.
        const mail = unread.map((m): NoticeMail => ({
            id: m.id,
            from: m.from,
            fromName: m.from === HUMAN ? null : m.app ? m.app.label : input.agents.get(m.from)?.name ?? null,
            text: m.text.length > NOTICE_MAIL_CHARS ? `${m.text.slice(0, NOTICE_MAIL_CHARS - 1)}…` : m.text,
            sentAt: m.sentAt,
        }));
        return [{ agentId: id, text, mail }];
    });
}
