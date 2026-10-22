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
export function rowsPatch<R>(prev: HeldRows<R> | null, next: readonly R[]): RowsPatch<R> {
    // Sent rows are always a COPY: the host grows its array in place, and a receiver sharing it would change underneath.
    if (prev === null) return { base: null, keep: 0, append: next.slice() };
    /*
     * THE SAME ARRAY, GROWN IN PLACE (session-host `ledgerFor`): the host only appends to it and replaces its newest row,
     * so what changed is read from the length and last row held — O(changes). Compared with itself it would match
     * everywhere and send nothing.
     */
    if (prev.rows === next) {
        const keep = prev.length > 0 && next[prev.length - 1] !== prev.last ? prev.length - 1 : prev.length;
        return { base: prev.seq, keep, append: next.slice(keep) };
    }
    const max = Math.min(prev.rows.length, next.length);
    let keep = 0;
    while (keep < max && prev.rows[keep] === next[keep]) keep += 1;
    return { base: prev.seq, keep, append: next.slice(keep) };
}

/** What a sender holds of its last push: the rows, and their length and last row AT THAT PUSH (the array may grow since). */
export interface HeldRows<R> {
    readonly seq: number;
    readonly rows: readonly R[];
    readonly length: number;
    readonly last: R | undefined;
}

export function heldRows<R>(seq: number, rows: readonly R[]): HeldRows<R> {
    return { seq, rows, length: rows.length, last: rows[rows.length - 1] };
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

/** The preload's half: main's payloads for one agent, passed on AS THEY ARRIVED (a patch), never rebuilt. */
export type AgentWireSubscribe<D, R> = (agentId: string, onPayload: (payload: AgentPushPayload<D, R>) => void) => () => void;

/**
 * THE PAGE'S HALF: one receiver per agent, IN THE PAGE'S OWN WORLD, however many views watch it.
 *
 * WHY HERE AND NOT IN THE PRELOAD (the owner, 2026-10-22: "Nearly every time you do anything the whole UI freezes for a few
 * seconds"). The preload used to apply the patch and hand each view the whole detail. A value handed across
 * `contextBridge` is COPIED into the page's world, object by object, on the renderer's one thread — so every push of a
 * watched agent copied its entire ledger (thousands of rows, megabytes), once per view watching it, and main's patch saved
 * the wire nothing it did not then spend in the window. Across the bridge now goes the patch; the ledger is rebuilt on
 * this side, where the rows the page already holds are reused by reference.
 */
export class AgentDetailViews<D extends object, R> {
    readonly #wire: AgentWireSubscribe<D, R>;
    readonly #watching = new Map<string, { views: Set<{ onChange: (detail: (D & { rows: readonly R[] }) | null) => void }>; off: () => void }>();

    constructor(wire: AgentWireSubscribe<D, R>) {
        this.#wire = wire;
    }

    subscribe(agentId: string, onChange: (detail: (D & { rows: readonly R[] }) | null) => void): () => void {
        let watch = this.#watching.get(agentId);
        if (watch === undefined) {
            const receiver = new AgentDetailReceiver<D, R>();
            const views = new Set<{ onChange: (detail: (D & { rows: readonly R[] }) | null) => void }>();
            const off = this.#wire(agentId, (payload) => {
                const detail = receiver.apply(payload);
                // A patch for rows this page does not hold: the whole ledger main sends a new watcher is on its way.
                if (detail === undefined) return;
                for (const view of views) view.onChange(detail);
            });
            watch = { views, off };
            this.#watching.set(agentId, watch);
        }
        const view = { onChange };
        const w = watch;
        w.views.add(view);
        return () => {
            w.views.delete(view);
            if (w.views.size > 0 || this.#watching.get(agentId) !== w) return;
            this.#watching.delete(agentId);
            w.off();
        };
    }
}
