/**
 * AN AGENT'S DETAIL ON THE WIRE, main → the window (the owner, 2026-10-20: "severe UI lag like 3 seconds to show any text
 * at all and a whole minute plus to render an FTQ").
 *
 * The detail carries the agent's whole ledger — its recorded history and this run, thousands of rows, megabytes for a busy
 * agent — and main pushed ALL of it on every event: every tool update, every chunk of a streamed reply. Each push was a
 * structured clone in main and another in the window, which then drew the lot again.
 *
 * So the rows travel as a PATCH against what the window already holds: `keep` rows of the last push, then `append`. A
 * streamed reply's chunk is `keep: n - 1` and the one row that grew; a new tool call is `keep: n` and one row. `base` names
 * the push the patch applies to; `null` is a full ledger, which is what a window that holds nothing (it has just started
 * watching) receives first. A patch for a base the receiver does not hold is IGNORED, never guessed at: main sends a full
 * ledger to every new watcher, so nothing is lost — the receiver simply waits for it.
 */

export interface RowsPatch<R> {
    /** The push this patch applies to; `null` = a full ledger (`keep` is 0). */
    readonly base: number | null;
    /** How many rows of the base stay, from its start. */
    readonly keep: number;
    /** The rows after them, in order. */
    readonly append: readonly R[];
}

export interface AgentPushPayload<D, R> {
    /** This push's number, per agent: what the next patch names as its base. */
    readonly seq: number;
    /** The detail without its rows; `null` = no such agent. */
    readonly detail: D | null;
    readonly rows: RowsPatch<R>;
}

/**
 * The patch that turns `prev` into `next`: the longest run of rows they share from the start BY IDENTITY (the host keeps
 * a row's object while it is unchanged, and replaces it when it changes — a reply's growing text, a renumbered turn), and
 * the rest. O(n) reference comparisons, no serialisation.
 */
export function rowsPatch<R>(prev: { seq: number; rows: readonly R[] } | null, next: readonly R[]): RowsPatch<R> {
    if (prev === null) return { base: null, keep: 0, append: next };
    const max = Math.min(prev.rows.length, next.length);
    let keep = 0;
    while (keep < max && prev.rows[keep] === next[keep]) keep += 1;
    return { base: prev.seq, keep, append: keep === 0 ? next : next.slice(keep) };
}

/**
 * The receiving end: one per agent the window watches. `apply` answers the whole detail, rows rebuilt, or `undefined`
 * when the payload was a patch for a base it does not hold (it waits for the full ledger main sends a new watcher).
 */
export class AgentDetailReceiver<D extends object, R> {
    #held: { seq: number; rows: readonly R[] } | null = null;

    apply(payload: AgentPushPayload<D, R>): (D & { rows: readonly R[] }) | null | undefined {
        const { rows } = payload;
        let next: readonly R[];
        if (rows.base === null) {
            next = rows.append;
        } else {
            if (this.#held === null || this.#held.seq !== rows.base) return undefined;
            next = rows.keep === this.#held.rows.length && rows.append.length === 0 ? this.#held.rows : [...this.#held.rows.slice(0, rows.keep), ...rows.append];
        }
        this.#held = { seq: payload.seq, rows: next };
        return payload.detail === null ? null : { ...payload.detail, rows: next };
    }

    /** Forget what is held: the next patch is ignored until a full ledger arrives. */
    reset(): void {
        this.#held = null;
    }
}
