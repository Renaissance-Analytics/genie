import type { TimedEvent } from './stream-view.js';

/**
 * WHAT AN AGENT IS DOING NOW — the workspace dashboard's card (the owner, 2026-10-19; the design approved in q_09d1f4a0:
 * "what it was asked; what it is doing now (the tool it's in)"). Read from the agent's own rows, newest first:
 *
 *   - `prompt`: the first line of the latest message that STARTED a turn — yours or a peer's; the agent's own words are
 *     an answer, not an ask;
 *   - `tool`: a call made after that prompt whose latest status is `pending` or `in_progress` — by its title, else its
 *     name. A call with no status reported is not claimed to be running (`null` is not `pending`, stream-event.ts), and
 *     one left open in an earlier turn is not what the agent is in now.
 */
export interface TurnNow {
    prompt: string | null;
    tool: string | null;
}

const firstLine = (text: string): string => (text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '').slice(0, 200);

export function turnNow(rows: readonly TimedEvent[]): TurnNow {
    let start = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const e = rows[i]!.event;
        if (e.kind === 'message' && e.speaker !== 'agent' && firstLine(e.text).length > 0) {
            start = i;
            break;
        }
    }
    const prompt = start >= 0 ? firstLine((rows[start]!.event as { text: string }).text) : null;

    // A call arrives as several rows (its input, then its updates): the latest status wins, the first title or name.
    const calls = new Map<string, { label: string | null; status: string | null; index: number }>();
    for (let i = start + 1; i < rows.length; i += 1) {
        const e = rows[i]!.event;
        if (e.kind !== 'tool' || !e.toolCallId) continue;
        const c = calls.get(e.toolCallId);
        calls.set(e.toolCallId, {
            label: c?.label ?? e.title ?? e.name,
            status: e.status ?? c?.status ?? null,
            index: c?.index ?? i,
        });
    }
    const open = [...calls.values()].filter((c) => (c.status === 'pending' || c.status === 'in_progress') && c.label !== null).sort((a, b) => b.index - a.index);
    return { prompt, tool: open[0]?.label ?? null };
}

/**
 * `turnNow`, KEPT AS THE ROWS ARRIVE (see `DeliveryTracker` in core/delivery.ts for why): the latest prompt, and the calls
 * made since it with the open ones indexed, so reading it costs the calls still open — not the whole ledger.
 * `test/live-readings.test.ts` holds it equal to `turnNow`.
 */
export class TurnNowTracker {
    #start = -1;
    #prompt: string | null = null;
    readonly #calls = new Map<string, { label: string | null; status: string | null; index: number }>();
    readonly #open = new Set<string>();

    /** The row at `index` arrived (appended). */
    add(rows: readonly TimedEvent[], index: number): void {
        const e = rows[index]!.event;
        if (e.kind === 'message') {
            if (e.speaker !== 'agent' && firstLine(e.text).length > 0) this.#begin(index, e.text);
            return;
        }
        if (e.kind !== 'tool' || !e.toolCallId) return;
        const c = this.#calls.get(e.toolCallId);
        const next = { label: c?.label ?? e.title ?? e.name, status: e.status ?? c?.status ?? null, index: c?.index ?? index };
        this.#calls.set(e.toolCallId, next);
        if ((next.status === 'pending' || next.status === 'in_progress') && next.label !== null) this.#open.add(e.toolCallId);
        else this.#open.delete(e.toolCallId);
    }

    /** The message at `index` (the newest row) grew in place. */
    grew(rows: readonly TimedEvent[], index: number): void {
        const e = rows[index]!.event;
        if (e.kind !== 'message' || e.speaker === 'agent' || firstLine(e.text).length === 0) return;
        // The newest row: nothing came after it, so as a new prompt it opens an empty turn.
        if (index === this.#start) this.#prompt = firstLine(e.text);
        else this.#begin(index, e.text);
    }

    current(): TurnNow {
        let best: { label: string | null; index: number } | null = null;
        for (const id of this.#open) {
            const c = this.#calls.get(id)!;
            if (best === null || c.index > best.index) best = c;
        }
        return { prompt: this.#prompt, tool: best?.label ?? null };
    }

    #begin(index: number, text: string): void {
        this.#start = index;
        this.#prompt = firstLine(text);
        this.#calls.clear();
        this.#open.clear();
    }
}
