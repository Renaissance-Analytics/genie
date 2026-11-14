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

import { searchNeedle } from './inbox-view.js';

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

/*
 * BUILT ONCE PER CHANGE (Tynn #663). Every features snapshot in window main lists the threads over ALL the mail; at the
 * owner's scale (9,500 mails) building every thread each time — joining every message's text into a haystack only to keep
 * its last 20,000 characters — was about 2.7 GB of garbage per 5 minutes in the #662 soak. The inbox never edits a message
 * in place: a send appends one, a read or a refusal replaces it, a delete drops it. So a thread whose messages are the SAME
 * objects as last time, under the same two names, is the same summary, and it is not built again. Everything a summary
 * says comes from its messages and the names of its two participants (the last sender and a waiting recipient are one of
 * them), so those are all it is checked against. Kept weakly, under the thread's first message: when that message goes
 * or is replaced, the entry goes with it.
 */
const pairOfMail = new WeakMap<ThreadMail, string>();
const builtThreads = new WeakMap<ThreadMail, { readonly list: readonly ThreadMail[]; readonly aName: string; readonly bName: string; readonly summary: ThreadSummary }>();

function mailPair(m: ThreadMail): string {
    let key = pairOfMail.get(m);
    if (key === undefined) {
        key = pairKey(m.from, m.to);
        pairOfMail.set(m, key);
    }
    return key;
}

/**
 * What search reads: both names and every text, joined, lower-cased, the LAST `HAYSTACK_CHARS`. Read from the end, so a
 * thread of thousands of messages reads only the texts that reach into the window. Whole messages only, each after a
 * newline as in the full join, so lower-casing sees the same context (a final sigma never looks across a newline) and the
 * window is exactly the full join's. Anything shorter than the window is the full join.
 */
function haystackOf(aName: string, bName: string, sorted: readonly ThreadMail[]): string {
    const tail: string[] = [];
    let length = 0;
    let i = sorted.length - 1;
    for (; i >= 0 && length < HAYSTACK_CHARS; i -= 1) {
        const text = sorted[i]!.text;
        length += text.length + (tail.length > 0 ? 1 : 0);
        tail.push(text);
    }
    tail.reverse();
    if (i < 0) return [aName, bName, ...tail].join('\n').toLowerCase().slice(-HAYSTACK_CHARS);
    const lowered = tail.join('\n').toLowerCase();
    // Lower-casing does not shorten text, so this always holds; if it ever did not, the full join is still the answer.
    return lowered.length >= HAYSTACK_CHARS ? lowered.slice(-HAYSTACK_CHARS) : [aName, bName, ...sorted.map((m) => m.text)].join('\n').toLowerCase().slice(-HAYSTACK_CHARS);
}

function threadSummary(key: string, list: readonly ThreadMail[], aName: string, bName: string): ThreadSummary {
    const sorted = [...list].sort((x, y) => x.seq - y.seq);
    const last = sorted[sorted.length - 1]!;
    const [a, b] = pairOf(key)!;
    const nameOf = (participant: string): string => (participant === a ? aName : bName);
    const waitingMail = sorted.filter((m) => m.to !== HUMAN && m.readAt === null);
    const oldest = waitingMail[0];
    return {
        key, a, b, aName, bName,
        withHuman: a === HUMAN || b === HUMAN,
        count: sorted.length,
        lastFrom: nameOf(last.from),
        lastPreview: preview(last.text),
        lastAt: Date.parse(last.sentAt),
        lastSeq: last.seq,
        unread: sorted.filter((m) => m.to === HUMAN && m.readAt === null).length,
        waiting: oldest ? { agent: nameOf(oldest.to), count: waitingMail.length, since: Date.parse(oldest.sentAt) } : null,
        attachments: sorted.reduce((n, m) => n + m.attachments.length, 0),
        haystack: haystackOf(aName, bName, sorted),
    };
}

/** Every thread in the mail, newest activity first. `name` names a participant (`human` → `you`). */
export function inboxThreads(mail: readonly ThreadMail[], name: (participant: string) => string): ThreadSummary[] {
    const groups = new Map<string, ThreadMail[]>();
    for (const m of mail) {
        const key = mailPair(m);
        const list = groups.get(key);
        if (list) list.push(m);
        else groups.set(key, [m]);
    }
    const out: ThreadSummary[] = [];
    for (const [key, list] of groups) {
        const [a, b] = pairOf(key)!;
        const aName = name(a);
        const bName = name(b);
        const first = list[0]!;
        const kept = builtThreads.get(first);
        if (kept && kept.aName === aName && kept.bName === bName && kept.list.length === list.length && kept.list.every((m, i) => m === list[i])) {
            out.push(kept.summary);
            continue;
        }
        const summary = threadSummary(key, list, aName, bName);
        builtThreads.set(first, { list, aName, bName, summary });
        out.push(summary);
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

/**
 * A WINDOW of one thread, oldest first (the owner, 2026-11-01: sort and page the thread). No seq: the newest `limit`. With
 * `beforeSeq`: the `limit` just older than it (Load older). With `fromSeq`: everything from it on, up to `limit` (a live
 * refresh of what is on screen). `more` = older mail exists before the window; `newer` = newer mail exists after it.
 */
export function threadWindow<M extends ThreadMail>(mail: readonly M[], key: string, opts: { limit: number; beforeSeq?: number | undefined; fromSeq?: number | undefined }): { key: string; messages: M[]; more: boolean; newer: boolean } {
    const all = mail.filter((m) => pairKey(m.from, m.to) === key).sort((x, y) => x.seq - y.seq);
    const n = Math.max(1, opts.limit);
    let start: number;
    let end: number;
    if (opts.fromSeq !== undefined) {
        const from = opts.fromSeq;
        start = all.findIndex((m) => m.seq >= from);
        if (start === -1) start = all.length;
        end = Math.min(all.length, start + n);
    } else {
        const before = opts.beforeSeq;
        end = before === undefined ? all.length : all.filter((m) => m.seq < before).length;
        start = Math.max(0, end - n);
    }
    return { key, messages: all.slice(start, end), more: start > 0, newer: end < all.length };
}

/**
 * SEARCH ONE THREAD over its STORED mail — every message the host holds, not what a window has loaded. Matches the text
 * (question ids are in it; a shortened `q_e07a0573…` matches too) and the sender's name. Case-insensitive. Newest hits
 * first, at most `max`; `total` counts them all.
 */
export function searchThread<M extends ThreadMail>(mail: readonly M[], key: string, query: string, name: (participant: string) => string, max: number): { hits: M[]; total: number } {
    const q = searchNeedle(query);
    if (q === '') return { hits: [], total: 0 };
    const matched = mail
        .filter((m) => pairKey(m.from, m.to) === key && (m.text.toLowerCase().includes(q) || name(m.from).toLowerCase().includes(q)))
        .sort((x, y) => y.seq - x.seq);
    return { hits: matched.slice(0, Math.max(0, max)), total: matched.length };
}
