/**
 * MAIL BETWEEN AGENTS, AS THE DASHBOARD DRAWS IT (genie#1209; the owner, 2026-10-26: "a signal animation when one agent
 * sends another agent a msg. It should travel from the agent sending to the agent receiving with indication when
 * read"). A send starts a signal from the sender to the recipient; a read marks it; it goes MAIL_SIGNAL_MS after its last
 * change. Mail to or from the person is not drawn: it has no row.
 */
export interface MailSignal {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly sentAt: number;
    readonly readAt: number | null;
}

export type MailSignalEvent =
    | { kind: 'sent'; id: string; from: string; to: string; at: number }
    | { kind: 'read'; ids: readonly string[]; at: number }
    | { kind: 'tick'; at: number };

/** How long a signal stays after its last change (sent, or read). */
export const MAIL_SIGNAL_MS = 6_000;
/** The most drawn at once: a burst of mail never floods the board. */
const MOST = 24;

export function mailSignals(current: readonly MailSignal[], event: MailSignalEvent): readonly MailSignal[] {
    if (event.kind === 'sent') {
        if (event.from === 'human' || event.to === 'human' || event.from === event.to) return current;
        return [...current.filter((s) => s.id !== event.id), { id: event.id, from: event.from, to: event.to, sentAt: event.at, readAt: null }].slice(-MOST);
    }
    if (event.kind === 'read') {
        const ids = new Set(event.ids);
        return current.some((s) => ids.has(s.id) && s.readAt === null) ? current.map((s) => (ids.has(s.id) && s.readAt === null ? { ...s, readAt: event.at } : s)) : current;
    }
    const kept = current.filter((s) => event.at < (s.readAt ?? s.sentAt) + MAIL_SIGNAL_MS);
    return kept.length === current.length ? current : kept;
}
