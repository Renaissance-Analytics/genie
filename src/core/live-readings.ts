import { DeliveryTracker } from './delivery.js';
import type { Delivery } from './dashboard-view.js';
import type { StreamEvent } from './stream-event.js';
import type { TimedEvent } from './stream-view.js';
import { TurnNowTracker, type TurnNow } from './turn-now.js';

/**
 * WHAT A LIVE SESSION READS FROM ITS OWN ROWS — its context figure, latest delivery, plan, model, and what it is doing now
 * — KEPT AS THE ROWS ARRIVE.
 *
 * The owner, 2026-10-20: "severe UI lag like 3 seconds to show any text at all and a whole minute plus to render an FTQ."
 * Genie's main process sat at a full core while the agent `tynn` streamed into a 66k-row thread: every event, the host's
 * `probe()` read ALL of an agent's rows again for each of these, and the Dashboard's snapshot and the window's detail each
 * called it. Kept here, each row costs O(1) when it arrives and a read costs nothing that grows with the ledger.
 *
 * The rules are the batch functions' (`usageFrom`, `planFrom`, `modelFrom`, `deliveryFrom`, `turnNow`), and
 * `test/live-readings.test.ts` holds every reading equal to them over random ledgers, a growing reply included.
 *
 * A ledger changes in two ways only: a row is APPENDED, or the newest row is REPLACED by the same message (or thought) with
 * more text on the end (`AgentSession` — `replacesLast`). Anything else replaced is not expected, and is answered by
 * reading the rows again from the start (`rebuild`), never by guessing.
 */
export class LiveReadings {
    #usage: { used: number; size: number } | null = null;
    #plan: Extract<StreamEvent, { kind: 'plan' }> | null = null;
    #model: string | null = null;
    #delivery = new DeliveryTracker();
    #turn = new TurnNowTracker();

    /** The row at `index` — the newest — arrived. */
    added(rows: readonly TimedEvent[], index: number): void {
        const e = rows[index]!.event;
        if (e.kind === 'usage') this.#usage = { used: e.used, size: e.size };
        else if (isSizedCompaction(e)) { if (this.#usage !== null) this.#usage = { used: e.after, size: this.#usage.size }; }
        else if (e.kind === 'plan') this.#plan = e;
        else if (e.kind === 'notice' && typeof e.model === 'string' && e.model.length > 0) this.#model = e.model;
        this.#delivery.add(rows, index);
        this.#turn.add(rows, index);
    }

    /** The newest row (at `index`) was replaced; `before` is the event it held. */
    replaced(rows: readonly TimedEvent[], index: number, before: StreamEvent): void {
        const e = rows[index]!.event;
        if (e.kind === 'message' && before.kind === 'message') {
            this.#delivery.grew(rows, index);
            this.#turn.grew(rows, index);
            return;
        }
        // A thought grew: no reading looks at thoughts.
        if (e.kind === 'think' && before.kind === 'think') return;
        this.rebuild(rows);
    }

    /** Read every row again, from the start. */
    rebuild(rows: readonly TimedEvent[]): void {
        this.#usage = null;
        this.#plan = null;
        this.#model = null;
        this.#delivery = new DeliveryTracker();
        this.#turn = new TurnNowTracker();
        for (let i = 0; i < rows.length; i += 1) this.added(rows, i);
    }

    get usage(): { used: number; size: number } | null {
        return this.#usage;
    }

    get plan(): { step: number; of: number; doing: string } | null {
        return this.#plan === null ? null : planOf(this.#plan);
    }

    get model(): string | null {
        return this.#model;
    }

    delivery(rows: readonly TimedEvent[], now: number): Delivery | null {
        return this.#delivery.current(rows, now);
    }

    turnNow(): TurnNow {
        return this.#turn.current();
    }
}

/**
 * The context figure: the newest of the last usage report and a later compaction's own post-compaction count — both the
 * provider's, never a running total of ours. A compaction says no window size, so it reads against the last report's;
 * before any report there is no window to read it against, and the figure stays `null`.
 *
 * WHY the compaction counts (the owner, 2026-10-21): the provider reports usage once, at the END of a turn, so a
 * compaction in the middle of a long turn left the meter on 959k of 1M for as long as the turn ran (17 minutes, once).
 */
export function usageFrom(rows: readonly TimedEvent[]): { used: number; size: number } | null {
    let after: number | null = null;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const e = rows[i]!.event;
        if (e.kind === 'usage') return { used: after ?? e.used, size: e.size };
        if (after === null && isSizedCompaction(e)) after = e.after;
    }
    return null;
}

/** A compaction that said how much context it left. */
function isSizedCompaction(e: StreamEvent): e is Extract<StreamEvent, { kind: 'divider' }> & { after: number } {
    return e.kind === 'divider' && e.variant === 'compaction' && e.after !== null;
}

/** The latest plan the agent reported, or `null`. Never a fabricated `0/0`. */
export function planFrom(rows: readonly TimedEvent[]): { step: number; of: number; doing: string } | null {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const event = rows[i]?.event;
        if (event?.kind === 'plan') return planOf(event);
    }
    return null;
}

function planOf(event: Extract<StreamEvent, { kind: 'plan' }>): { step: number; of: number; doing: string } | null {
    const steps = event.entries.flatMap((e) => {
        if (typeof e !== 'object' || e === null) return [];
        const r = e as Record<string, unknown>;
        return typeof r['content'] === 'string' && typeof r['status'] === 'string' ? [{ content: r['content'], status: r['status'] }] : [];
    });
    if (steps.length === 0) return null;

    const done = steps.filter((s) => s.status === 'completed').length;
    const doing = steps.find((s) => s.status === 'in_progress');
    return { step: done, of: steps.length, doing: doing?.content ?? '' };
}

/**
 * The model the provider last REPORTED running (a notice carrying it), or `null`. The latest report wins — Codex
 * reroutes mid-session — and it is never the model Genie asked for: that is the agent's setting, not a reading.
 */
export function modelFrom(rows: readonly TimedEvent[]): string | null {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const event = rows[i]?.event;
        if (event?.kind === 'notice' && typeof event.model === 'string' && event.model.length > 0) return event.model;
    }
    return null;
}
