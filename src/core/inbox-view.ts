/**
 * THE AGENTINBOX THREAD AS THE PERSON SEES IT: order, the bounded buffer, scroll, search marks and question ids (the owner,
 * 2026-11-01: "msgs in the inbox should be sortable and searchable, sort newest on top by default." and "for FTQ responses
 * in the inbox, the id should be a link that expands to show the questions asked."). Pure: the flyout decides with these.
 *
 * THE BUFFER. A thread on screen is at most `THREAD_BUFFER` messages (the live-view rule, owner 2026-10-22: "history
 * should buffer with only the last 500 lines present when Following Live"). Each answer from the host is MERGED into it
 * (`mergeWindow`): an unchanged message keeps its object, so React keeps its card — an update patches, never rebuilds.
 */

/** The most messages a thread holds on screen. Paging back past it trims the newest end (and offers the way back). */
export const THREAD_BUFFER = 500;

export type ThreadOrder = 'newest' | 'oldest';

/** What the buffer holds of a message: enough to order it, tell it apart, and see whether it changed. */
interface Buffered {
    readonly seq: number;
    readonly id: string;
    readonly readAt: string | null;
    readonly text: string;
}

/** The buffer (oldest first) in the order shown. Newest on top is the default. */
export function inViewOrder<M>(messages: readonly M[], order: ThreadOrder = 'newest'): M[] {
    return order === 'newest' ? [...messages].reverse() : [...messages];
}

const same = (a: Buffered, b: Buffered): boolean => a.id === b.id && a.seq === b.seq && a.readAt === b.readAt && a.text === b.text;

/**
 * An answer merged into the buffer. `covers` is the seq range the answer speaks for: a buffered message inside it that
 * the answer does not hold is gone from the host (a deleted thread or message) and leaves. An unchanged message keeps its
 * old object. Past `cap`, the end named by `trim` is cut — the NEWEST after paging back, so what was just asked for stays.
 */
export function mergeWindow<M extends Buffered>(buffer: readonly M[], incoming: readonly M[], covers: { from: number; to: number }, trim: 'newest' | 'oldest', cap: number): { messages: M[]; trimmed: boolean } {
    const old = new Map(buffer.map((m) => [m.id, m] as const));
    const kept = buffer.filter((m) => m.seq < covers.from || m.seq > covers.to);
    const fresh = incoming.map((m) => {
        const was = old.get(m.id);
        return was && same(was, m) ? was : m;
    });
    const byId = new Map<string, M>();
    for (const m of [...kept, ...fresh]) byId.set(m.id, m);
    const all = [...byId.values()].sort((x, y) => x.seq - y.seq);
    if (all.length <= cap) return { messages: all, trimmed: false };
    return { messages: trim === 'newest' ? all.slice(0, cap) : all.slice(all.length - cap), trimmed: true };
}

/**
 * Where the scroller goes after the list changed, or `null` to leave it. Rows inserted ABOVE what the person reads would
 * push it down; the scroller follows them so the reading position holds — except at the top of a newest-first thread,
 * where staying put is how new mail is seen. A fresh thread opens at its newest end. The flyout turns the browser's own
 * scroll anchoring off so this is the one rule.
 */
export function scrollAfterInsert(i: { order: ThreadOrder; cause: 'live' | 'older' | 'reset'; prevTop: number; prevHeight: number; newHeight: number }): number | null {
    if (i.cause === 'reset') return i.order === 'newest' ? 0 : i.newHeight;
    const insertedAbove = (i.order === 'newest' && i.cause === 'live') || (i.order === 'oldest' && i.cause === 'older');
    if (!insertedAbove) return null;
    if (i.order === 'newest' && i.prevTop <= 0) return null;
    return i.prevTop + (i.newHeight - i.prevHeight);
}

/** A search as typed, ready to match: trimmed, lower-cased, a trailing `…` (a shortened question id) dropped. */
export function searchNeedle(query: string): string {
    return query.trim().replace(/…+$/, '').trim().toLowerCase();
}

/** The text cut into runs, each a match of the query or not (case-insensitive). */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
    const q = searchNeedle(query);
    if (q === '') return [{ text, hit: false }];
    const lower = text.toLowerCase();
    const out: { text: string; hit: boolean }[] = [];
    let at = 0;
    for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length)) {
        if (i > at) out.push({ text: text.slice(at, i), hit: false });
        out.push({ text: text.slice(i, i + q.length), hit: true });
        at = i + q.length;
    }
    if (at < text.length) out.push({ text: text.slice(at), hit: false });
    return out.length > 0 ? out : [{ text, hit: false }];
}

/** One line of a message around its first match, `radius` characters each side, `…` where cut. */
export function searchSnippet(text: string, query: string, radius: number): string {
    const one = text.replace(/\s+/g, ' ').trim();
    const q = searchNeedle(query);
    const i = q === '' ? -1 : one.toLowerCase().indexOf(q);
    if (i === -1) return one.length > radius * 2 ? `${one.slice(0, radius * 2)}…` : one;
    const start = Math.max(0, i - radius);
    const end = Math.min(one.length, i + q.length + radius);
    return `${start > 0 ? '…' : ''}${one.slice(start, end)}${end < one.length ? '…' : ''}`;
}

/** A ForceTheQuestion id as `attention-store` mints it: `q_` and a UUID. */
const QUESTION_ID = /q_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ANSWER_LINE = /^Answer to your question (q_[0-9a-f-]{36}):[ \t]*\r?\n?/i;

/**
 * The question a message is about, when it names one: an FTQ ANSWER (its first line, `Answer to your question q_…:`, is
 * replaced by the id's link, so `rest` is the text under it) or another mention — a dismissal's `(Your question q_….)` —
 * where the text is kept whole.
 */
export function questionRef(text: string): { id: string; kind: 'answer' | 'mention'; rest: string } | null {
    const answer = ANSWER_LINE.exec(text);
    if (answer && QUESTION_ID.test(answer[1]!)) return { id: answer[1]!, kind: 'answer', rest: text.slice(answer[0].length) };
    const found = QUESTION_ID.exec(text);
    return found ? { id: found[0], kind: 'mention', rest: text } : null;
}

/** `q_e07a0573…` — the id as shown; the whole id goes in its tooltip. */
export function shortQuestionId(id: string): string {
    return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}

/** The order toggle's icon by the order it shows (registered in renderer/icons.ts from here). */
export const ORDER_ICON: Readonly<Record<ThreadOrder, string>> = { newest: 'arrow-down-wide-narrow', oldest: 'arrow-up-narrow-wide' };
