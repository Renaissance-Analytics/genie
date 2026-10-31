/**
 * THE AGENTINBOX AS THREADS (beta.33 item 19; the owner: "The genie 2 AgentInbox UX is still nothing like genie 1's which
 * was not perfect but it was much better"). Pure: main reads the mail, this decides what the flyout shows.
 *
 * Genie 1's model, kept: a thread is a PAIR of participants (`pairKey`, Genie 1's `main/agentinbox/broker.ts:151`) —
 * the person with an agent, or two agents with each other — newest activity first. What it improves on, measured
 * against Genie 1's code (review-g1 `AgentInboxFlyout.tsx`):
 *  - search reads every message's text, not only the last 140 characters of each thread (Genie 1 `:682-687`);
 *  - a thread's history pages back (`threadOf` `limit` + `more`) — Genie 1 always showed the newest 100 and stopped;
 *  - "waiting" is read from the mail itself — messages an agent has not collected, and since when — so it is right
 *    after a restart (Genie 1's escalations lived in the open panel's state and were lost on a reload, `:452-471`).
 *
 * `unread` is the PERSON's: mail to the person not yet read (the inbox's own `readAt`). `waiting` is the AGENTS': mail
 * to an agent it has not collected — Genie 1's lag badge, per thread.
 */

export const HUMAN = 'human';

/** The fields of an inbox message the threads read (`main/inbox-store.ts`'s `InboxMessage`). */
export interface ThreadMail {
    readonly seq: number;
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly text: string;
    readonly attachments: readonly { readonly id: string; readonly name: string; readonly size: number }[];
    readonly sentAt: string;
    readonly readAt: string | null;
    /** An APP sent it (genie#1345): what it reported beside the text, and how it is labelled. Absent otherwise. */
    readonly app?: { readonly label: string; readonly subject: string; readonly level: 'info' | 'success' | 'failure'; readonly link?: string; readonly source: { readonly kind: 'site' | 'process' | 'script'; readonly name: string } };
}

export interface ThreadSummary {
    /** `pairKey(a, b)` — the thread's address in a route. */
    readonly key: string;
    /** The two participants, sorted (`human` or an agent id). */
    readonly a: string;
    readonly b: string;
    readonly aName: string;
    readonly bName: string;
    /** The person is one of the two: a thread the person can write in. Otherwise it is read-only. */
    readonly withHuman: boolean;
    readonly count: number;
    readonly lastFrom: string;
    readonly lastPreview: string;
    /** Epoch ms of the newest message. */
    readonly lastAt: number;
    readonly lastSeq: number;
    /** Mail to the person in this thread, not yet read. */
    readonly unread: number;
    /** Mail to an agent in this thread it has not collected: the oldest such message's recipient and time; `null` = none. */
    readonly waiting: { readonly agent: string; readonly count: number; readonly since: number } | null;
    /** Attachments in the thread. */
    readonly attachments: number;
    /** Every name and message text, lower-cased: what search reads. */
    readonly haystack: string;
}

export type ThreadFilter = 'all' | 'unread' | 'waiting' | 'stale';
export const THREAD_FILTERS: readonly ThreadFilter[] = ['all', 'unread', 'waiting', 'stale'];
/** A thread with no traffic for this long is stale (Genie 1: 24 hours). */
export const STALE_MS = 24 * 60 * 60 * 1000;
const PREVIEW_CHARS = 140;
const HAYSTACK_CHARS = 20_000;

export function pairKey(a: string, b: string): string {
    return [a, b].sort().join('|');
}

export function pairOf(key: string): [string, string] | null {
    const parts = key.split('|');
    return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

const preview = (text: string): string => {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS - 1)}…` : one;
};

/** Every thread in the mail, newest activity first. `name` names a participant (`human` → `you`). */
export function inboxThreads(mail: readonly ThreadMail[], name: (participant: string) => string): ThreadSummary[] {
    const groups = new Map<string, ThreadMail[]>();
    for (const m of mail) {
        const key = pairKey(m.from, m.to);
        const list = groups.get(key);
        if (list) list.push(m);
        else groups.set(key, [m]);
    }
    const out: ThreadSummary[] = [];
    for (const [key, list] of groups) {
        const sorted = [...list].sort((x, y) => x.seq - y.seq);
        const last = sorted[sorted.length - 1]!;
        const [a, b] = pairOf(key)!;
        const waitingMail = sorted.filter((m) => m.to !== HUMAN && m.readAt === null);
        const oldest = waitingMail[0];
        out.push({
            key, a, b, aName: name(a), bName: name(b),
            withHuman: a === HUMAN || b === HUMAN,
            count: sorted.length,
            lastFrom: name(last.from),
            lastPreview: preview(last.text),
            lastAt: Date.parse(last.sentAt),
            lastSeq: last.seq,
            unread: sorted.filter((m) => m.to === HUMAN && m.readAt === null).length,
            waiting: oldest ? { agent: name(oldest.to), count: waitingMail.length, since: Date.parse(oldest.sentAt) } : null,
            attachments: sorted.reduce((n, m) => n + m.attachments.length, 0),
            haystack: [name(a), name(b), ...sorted.map((m) => m.text)].join('\n').toLowerCase().slice(-HAYSTACK_CHARS),
        });
    }
    // Newest activity first, by when it was sent (Genie 1: ts, then seq) — an imported history keeps its own seqs.
    const time = (t: ThreadSummary): number => (Number.isNaN(t.lastAt) ? -Infinity : t.lastAt);
    return out.sort((x, y) => time(y) - time(x) || y.lastSeq - x.lastSeq);
}

/** The threads a filter and a search leave. Search is case-insensitive, over names and every message's text. */
export function filterThreads(threads: readonly ThreadSummary[], opts: { filter: ThreadFilter; query: string; now: number }): ThreadSummary[] {
    const q = opts.query.trim().toLowerCase();
    return threads.filter((t) => {
        if (opts.filter === 'unread' && t.unread === 0) return false;
        if (opts.filter === 'waiting' && t.waiting === null) return false;
        if (opts.filter === 'stale' && !(opts.now - t.lastAt > STALE_MS)) return false;
        return q === '' || t.haystack.includes(q);
    });
}

/** How many threads each filter holds, for the chips. */
export function filterCounts(threads: readonly ThreadSummary[], now: number): Record<ThreadFilter, number> {
    return {
        all: threads.length,
        unread: threads.filter((t) => t.unread > 0).length,
        waiting: threads.filter((t) => t.waiting !== null).length,
        stale: threads.filter((t) => now - t.lastAt > STALE_MS).length,
    };
}

/** One thread's newest `limit` messages, oldest first, and whether there are older ones. */
export function threadOf<M extends ThreadMail>(mail: readonly M[], key: string, limit: number): { key: string; messages: M[]; more: boolean } {
    const all = mail.filter((m) => pairKey(m.from, m.to) === key).sort((x, y) => x.seq - y.seq);
    const n = Math.max(1, limit);
    return { key, messages: all.slice(-n), more: all.length > n };
}

/** The thread a message is in, or `null` for an id the mail does not hold. */
export function threadKeyOfMessage(mail: readonly ThreadMail[], messageId: string): string | null {
    const m = mail.find((x) => x.id === messageId);
    return m ? pairKey(m.from, m.to) : null;
}

/** Mail every agent has not collected yet — Genie 1's lag badge (`broker.agentLagCount`). */
export function uncollected(mail: readonly ThreadMail[]): number {
    return mail.filter((m) => m.to !== HUMAN && m.readAt === null).length;
}

/** `3m`, `2h`, `4d` — how long ago, Genie 1's `relTime`. */
export function ago(at: number, now: number): string {
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
}
