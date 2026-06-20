/**
 * Bounded per-terminal output ring buffer for the agent-integration MCP
 * `manageTerminals` / `runAgent` READ actions.
 *
 * An agent that drives a terminal needs to read what it produced — but the live
 * pty output stream (`onData`) is fire-and-forget into the renderer, and the
 * manager's own scrollback isn't cursor-addressable. So this module taps the
 * SAME `onData` fan-out into a small, capped buffer per terminal and exposes two
 * read shapes the MCP tools need:
 *
 *   - `readSince(id, cursor)` — everything appended since a prior cursor, plus a
 *     fresh cursor. This is the agent's "give me what's new" loop: write a
 *     command, then poll readSince until the output settles.
 *   - `readTail(id, bytes)`  — the last N bytes currently buffered (a one-shot
 *     "what's on screen now" without tracking a cursor).
 *
 * BOUNDING (the security requirement): each terminal keeps at most `CAP_BYTES`
 * of recent output. Appends beyond the cap drop the oldest bytes, so a runaway
 * process can never grow this unboundedly. The cursor is a monotonic count of
 * total bytes EVER appended (not an index into the trimmed buffer), so it stays
 * valid across trims; a read whose cursor predates what we still hold returns
 * the oldest retained bytes and signals `dropped`.
 *
 * Pure + dependency-free (no electron, no pty) so the buffer logic is unit
 * tested directly. ipc.ts feeds it from subscribeBackendEvents.onData and drops
 * a terminal's buffer on exit/kill.
 */

/** Max retained output per terminal. ~256 KiB — generous for a read loop,
 *  small enough that even many driven terminals stay bounded. */
export const CAP_BYTES = 256 * 1024;

interface Entry {
    /** The retained tail of this terminal's output (string; length ≤ CAP_BYTES). */
    buf: string;
    /** Total bytes (chars) EVER appended — the monotonic cursor space. */
    total: number;
}

export interface ReadResult {
    /** The output bytes for this read. */
    data: string;
    /** The cursor to pass to the NEXT readSince to continue from here. */
    cursor: number;
    /** True when some output between the requested cursor and now was already
     *  evicted by the cap (the agent missed bytes — surfaced so it knows). */
    dropped: boolean;
}

/**
 * A fixed-capacity collection of per-terminal output buffers. One instance backs
 * the whole app (module-scoped in ipc.ts); tests construct their own.
 */
export class TerminalReadBuffer {
    private readonly cap: number;
    private readonly entries = new Map<string, Entry>();

    constructor(cap: number = CAP_BYTES) {
        this.cap = cap > 0 ? cap : CAP_BYTES;
    }

    /** Append a chunk of pty output for `id`, trimming to the cap. */
    append(id: string, data: string): void {
        if (!data) return;
        let e = this.entries.get(id);
        if (!e) {
            e = { buf: '', total: 0 };
            this.entries.set(id, e);
        }
        e.total += data.length;
        const combined = e.buf + data;
        // Keep only the last `cap` chars; older output ages out of the window.
        e.buf = combined.length > this.cap ? combined.slice(combined.length - this.cap) : combined;
    }

    /**
     * Everything appended since `cursor` (a value from a prior read, or 0/undefined
     * for "from the start of what we hold"). Returns the new cursor to continue
     * from and whether any bytes were dropped before what we could return.
     */
    readSince(id: string, cursor?: number): ReadResult {
        const e = this.entries.get(id);
        if (!e) return { data: '', cursor: cursor ?? 0, dropped: false };

        // The oldest byte we still hold sits at this absolute offset.
        const oldestHeld = e.total - e.buf.length;
        const from = cursor === undefined || cursor < 0 ? oldestHeld : cursor;

        if (from >= e.total) {
            // Caller is already caught up (or passed a future cursor) — nothing new.
            return { data: '', cursor: e.total, dropped: false };
        }
        // Clamp to what we still retain; flag if their cursor predates it.
        const start = Math.max(from, oldestHeld);
        const dropped = from < oldestHeld;
        const data = e.buf.slice(start - oldestHeld);
        return { data, cursor: e.total, dropped };
    }

    /** The last `bytes` chars currently buffered for `id` (default: all held). */
    readTail(id: string, bytes?: number): ReadResult {
        const e = this.entries.get(id);
        if (!e) return { data: '', cursor: 0, dropped: false };
        if (bytes === undefined || bytes < 0 || bytes >= e.buf.length) {
            return {
                data: e.buf,
                cursor: e.total,
                dropped: e.buf.length < e.total,
            };
        }
        return {
            data: e.buf.slice(e.buf.length - bytes),
            cursor: e.total,
            dropped: true, // asked for a slice → older bytes intentionally omitted
        };
    }

    /** The current cursor for `id` (total bytes seen), for "start tailing from now". */
    cursor(id: string): number {
        return this.entries.get(id)?.total ?? 0;
    }

    /** Drop a terminal's buffer (on exit/kill) so it can't leak memory. */
    forget(id: string): void {
        this.entries.delete(id);
    }

    /** Number of buffered terminals (diagnostics/tests). */
    size(): number {
        return this.entries.size;
    }
}
