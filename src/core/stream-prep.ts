import { activityRows, resolveThinkTokens, resolveToolDurations, resolveTurnCosts, type TimedEvent } from './stream-view.js';

/**
 * THE WORK STREAM'S PREPARATION (the owner, 2026-10-22: never rebuild the whole thread per update).
 *
 * What the Stream shows is the ledger's activity (`activityRows`: no messages, debug notices put their estimate on the
 * thought before them, a tool call's updates folded into the call's row), with each thought's token delta
 * (`resolveThinkTokens`), each usage report's rise (`resolveTurnCosts`), each call's duration (`resolveToolDurations`,
 * over every frame) and each compaction divider's summarised turns. `prepareStream` is that pipeline over the whole
 * ledger — the reference. `StreamPrep` is the same result as a FOLD: it keeps what those passes carry from row to row,
 * reads only the rows a push adds, and undoes the newest row when the wire replaces it. Proven equal at every step of
 * generated pushes (test/stream-prep.test.ts).
 */

/** How many activity rows the Stream holds while Following Live, and how many each page of history adds. */
export const STREAM_LIVE_ROWS = 500;

export interface PreparedStream {
    /** The activity rows, tokens and costs resolved. */
    readonly rows: readonly TimedEvent[];
    /** A call's first frame to its terminal update, by toolCallId. */
    readonly durations: ReadonlyMap<string, number>;
    /** Per compaction divider (by row id): the highest turn started before it. */
    readonly summarised: ReadonlyMap<string, number>;
}

/** The reference: the whole pipeline over the whole ledger (what the Stream ran on every push). */
export function prepareStream(ledger: readonly TimedEvent[]): PreparedStream {
    const rows = resolveTurnCosts(resolveThinkTokens(activityRows(ledger)));
    const durations = resolveToolDurations(ledger);
    const summarised = new Map<string, number>();
    let turnsSoFar = 0;
    for (const row of rows) {
        if (row.event.kind === 'turn') turnsSoFar = Math.max(turnsSoFar, row.event.n);
        else if (row.event.kind === 'divider') summarised.set(row.id, turnsSoFar);
    }
    return { rows, durations, summarised };
}

type Totals = { cost: number | null; in: number | null; out: number | null };

/** What processing ONE ledger row changed — enough to put everything back as it was before it. */
interface Undo {
    outLength: number;
    replaced: Array<[number, TimedEvent]>;
    joinAdded: string | null;
    lastThink: number;
    usageSeen: boolean;
    lastUsed: number;
    pending: number[];
    previous: Totals;
    started: Array<[string, number | undefined]>;
    durations: Array<[string, number | undefined]>;
    turnsSoFar: number;
    summarisedAdded: string | null;
}

export class StreamPrep {
    #out: TimedEvent[] = [];
    /** toolCallId → its row in `#out` (joinToolCalls). */
    #join = new Map<string, number>();
    /** The newest thought in `#out` — where a debug notice's estimate goes (activityRows); -1 = none yet. */
    #lastThink = -1;
    /** resolveThinkTokens: a usage report seen yet, the last one's `used`, the thoughts since it. */
    #usageSeen = false;
    #lastUsed = 0;
    #pending: number[] = [];
    /** resolveTurnCosts: the last value of each running total. */
    #previous: Totals = { cost: null, in: null, out: null };
    /** resolveToolDurations. */
    #started = new Map<string, number>();
    #durations = new Map<string, number>();
    #turnsSoFar = 0;
    #summarised = new Map<string, number>();
    /** What the fold has read: how many ledger rows, the first and the newest (the wire only appends or replaces the newest). */
    #length = 0;
    #first: TimedEvent | undefined;
    #last: TimedEvent | undefined;
    #undo: Undo | null = null;

    /** The prepared stream for `ledger`, reading only what changed since the last call. */
    update(ledger: readonly TimedEvent[]): PreparedStream {
        const n = ledger.length;
        const sameBase = this.#length > 0 && n >= this.#length && ledger[0] === this.#first;
        if (!sameBase) {
            this.#reset();
            this.#process(ledger, 0);
        } else if (ledger[this.#length - 1] !== this.#last) {
            // The newest row was replaced (it grew, or its status moved): undo it, then read it and anything after again.
            if (this.#undo === null || this.#length < 2) {
                this.#reset();
                this.#process(ledger, 0);
            } else {
                this.#rollback(this.#undo);
                this.#length -= 1;
                this.#process(ledger, this.#length);
            }
        } else if (n > this.#length) {
            this.#process(ledger, this.#length);
        }
        // The fold's own array and maps, read by the caller now (a copy would cost the whole history again).
        return { rows: this.#out, durations: this.#durations, summarised: this.#summarised };
    }

    #reset(): void {
        this.#out = [];
        this.#join = new Map();
        this.#lastThink = -1;
        this.#usageSeen = false;
        this.#lastUsed = 0;
        this.#pending = [];
        this.#previous = { cost: null, in: null, out: null };
        this.#started = new Map();
        this.#durations = new Map();
        this.#turnsSoFar = 0;
        this.#summarised = new Map();
        this.#length = 0;
        this.#first = undefined;
        this.#last = undefined;
        this.#undo = null;
    }

    #process(ledger: readonly TimedEvent[], from: number): void {
        for (let j = from; j < ledger.length; j += 1) {
            const row = ledger[j]!;
            this.#undo = this.#fold(row);
            if (j === 0) this.#first = row;
            this.#last = row;
        }
        this.#length = ledger.length;
    }

    /** One ledger row through every pass; returns how to undo it. */
    #fold(row: TimedEvent): Undo {
        const undo: Undo = {
            outLength: this.#out.length, replaced: [], joinAdded: null, lastThink: this.#lastThink,
            usageSeen: this.#usageSeen, lastUsed: this.#lastUsed, pending: this.#pending.slice(), previous: { ...this.#previous },
            started: [], durations: [], turnsSoFar: this.#turnsSoFar, summarisedAdded: null,
        };
        const replace = (i: number, next: TimedEvent) => { undo.replaced.push([i, this.#out[i]!]); this.#out[i] = next; };
        const e = row.event;

        // resolveToolDurations: over EVERY frame, before the updates fold into their call.
        if (e.kind === 'tool') {
            const id = e.toolCallId;
            const terminal = e.status === 'completed' || e.status === 'failed';
            if (!terminal) {
                if (!this.#started.has(id) && row.at !== null) { undo.started.push([id, undefined]); this.#started.set(id, row.at); }
            } else if (row.at !== null) {
                const from = this.#started.get(id);
                if (from !== undefined) { undo.durations.push([id, this.#durations.get(id)]); this.#durations.set(id, row.at - from); }
            }
        }

        // activityRows: messages are the chat's; a debug notice is not a row, its estimate goes on the newest thought.
        if (e.kind === 'message') return undo;
        if (e.kind === 'notice' && e.level === 'debug') {
            if (typeof e.estimate === 'number' && this.#lastThink >= 0) {
                const t = this.#out[this.#lastThink]!;
                if (t.event.kind === 'think' && typeof t.event.estimate !== 'number') replace(this.#lastThink, { ...t, event: { ...t.event, estimate: e.estimate } });
            }
            return undo;
        }

        // joinToolCalls: a call's later frames fold into its row.
        if (e.kind === 'tool' && e.toolCallId !== '') {
            const at = this.#join.get(e.toolCallId);
            if (at !== undefined) {
                const prev = this.#out[at]!;
                const p = prev.event as typeof e;
                replace(at, { ...prev, event: { ...p, name: p.name ?? e.name, title: p.title ?? e.title, toolKind: p.toolKind ?? e.toolKind, rawInput: p.rawInput ?? e.rawInput, status: e.status } });
                return undo;
            }
            this.#join.set(e.toolCallId, this.#out.length);
            undo.joinAdded = e.toolCallId;
        }

        const index = this.#out.length;
        if (e.kind === 'usage') {
            // resolveThinkTokens: the rise in `used` since the last report, shared by the thoughts between.
            if (this.#usageSeen && this.#pending.length > 0) {
                const delta = e.used - this.#lastUsed;
                if (delta > 0) {
                    const share = Math.round(delta / this.#pending.length);
                    for (const i of this.#pending) {
                        const t = this.#out[i]!;
                        if (t.event.kind === 'think') replace(i, { ...t, event: { ...t.event, tokens: share } });
                    }
                }
            }
            this.#pending = [];
            this.#usageSeen = true;
            this.#lastUsed = e.used;
            // resolveTurnCosts: each running total's rise from the previous report that carried it.
            const rise = (key: keyof Totals, now: number | null | undefined, round: number): number | null => {
                if (typeof now !== 'number') return null;
                const before = this.#previous[key];
                this.#previous[key] = now;
                const d = before === null ? now : now - before;
                return d >= 0 ? Math.round(d * round) / round : null;
            };
            this.#out.push({ ...row, event: { ...e, turnCost: rise('cost', e.cost, 1e6), turnIn: rise('in', e.inTokens, 1), turnOut: rise('out', e.outTokens, 1) } });
            return undo;
        }

        this.#out.push({ ...row });
        if (e.kind === 'think') {
            this.#pending.push(index);
            this.#lastThink = index;
        } else if (e.kind === 'turn') this.#turnsSoFar = Math.max(this.#turnsSoFar, e.n);
        else if (e.kind === 'divider') {
            undo.summarisedAdded = row.id;
            this.#summarised.set(row.id, this.#turnsSoFar);
        }
        return undo;
    }

    #rollback(u: Undo): void {
        for (let k = u.replaced.length - 1; k >= 0; k -= 1) { const [i, prev] = u.replaced[k]!; this.#out[i] = prev; }
        this.#out.length = u.outLength;
        if (u.joinAdded !== null) this.#join.delete(u.joinAdded);
        this.#lastThink = u.lastThink;
        this.#usageSeen = u.usageSeen;
        this.#lastUsed = u.lastUsed;
        this.#pending = u.pending;
        this.#previous = u.previous;
        for (const [id, prev] of u.started) { if (prev === undefined) this.#started.delete(id); else this.#started.set(id, prev); }
        for (const [id, prev] of u.durations) { if (prev === undefined) this.#durations.delete(id); else this.#durations.set(id, prev); }
        this.#turnsSoFar = u.turnsSoFar;
        if (u.summarisedAdded !== null) this.#summarised.delete(u.summarisedAdded);
        this.#undo = null;
    }
}
