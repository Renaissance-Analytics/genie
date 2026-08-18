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
 * BUFFER PRESENCE IS PART OF THE ANSWER (genie#217): this buffer is fed by the
 * LIVE data stream only, so it holds nothing for a terminal whose output all
 * predates this process — a pty that survived a Genie restart inside the
 * detached pty-host, say. "0 bytes because we hold no buffer for this terminal"
 * and "0 bytes because the terminal is quiet" are DIFFERENT answers, so every
 * read reports `buffered`, and `seed()` lets the caller restore a missing buffer
 * from whatever scrollback DID survive before serving the read.
 *
 * Pure + dependency-free (no electron, no pty) so the buffer logic is unit
 * tested directly. ipc.ts feeds it from subscribeBackendEvents.onData, seeds it
 * from the backend's surviving scrollback, and drops a terminal's buffer on kill.
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
    /** True when this terminal HAS a buffer here (so empty `data` means the
     *  terminal was quiet). False means we hold nothing for it at all — empty
     *  `data` is then "we can't see this terminal", not "nothing happened". */
    buffered: boolean;
}

/**
 * What an EMPTY read actually means for a terminal (genie#217). Lives here, with
 * the buffer, so the MCP protocol types can name it without importing the pty
 * layer:
 *
 *   'live'     — the buffer is tracking this terminal. Empty data means it
 *                genuinely produced nothing (since the cursor).
 *   'restored' — no buffer was held (Genie restarted, or the pty-host client
 *                reconnected) and it was re-seeded from the scrollback that
 *                survived in the backend. The data is real history.
 *   'exited'   — the pty is not running. Empty data means there is nothing to
 *                read, NOT that the terminal is idle.
 */
export type TerminalReadState = 'live' | 'restored' | 'exited';

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
        if (!e) return { data: '', cursor: cursor ?? 0, dropped: false, buffered: false };

        // The oldest byte we still hold sits at this absolute offset.
        const oldestHeld = e.total - e.buf.length;
        const from = cursor === undefined || cursor < 0 ? oldestHeld : cursor;

        if (from >= e.total) {
            // Caller is already caught up (or passed a future cursor) — nothing new.
            return { data: '', cursor: e.total, dropped: false, buffered: true };
        }
        // Clamp to what we still retain; flag if their cursor predates it.
        const start = Math.max(from, oldestHeld);
        const dropped = from < oldestHeld;
        const data = e.buf.slice(start - oldestHeld);
        return { data, cursor: e.total, dropped, buffered: true };
    }

    /** The last `bytes` chars currently buffered for `id` (default: all held). */
    readTail(id: string, bytes?: number): ReadResult {
        const e = this.entries.get(id);
        if (!e) return { data: '', cursor: 0, dropped: false, buffered: false };
        if (bytes === undefined || bytes < 0 || bytes >= e.buf.length) {
            return {
                data: e.buf,
                cursor: e.total,
                dropped: e.buf.length < e.total,
                buffered: true,
            };
        }
        return {
            data: e.buf.slice(e.buf.length - bytes),
            cursor: e.total,
            dropped: true, // asked for a slice → older bytes intentionally omitted
            buffered: true,
        };
    }

    /** The current cursor for `id` (total bytes seen), for "start tailing from now". */
    cursor(id: string): number {
        return this.entries.get(id)?.total ?? 0;
    }

    /** True when we hold a buffer for `id` (even an empty one). */
    has(id: string): boolean {
        return this.entries.has(id);
    }

    /**
     * Populate a MISSING buffer from scrollback that outlived it — the pty-host's
     * mirror of a terminal that survived a Genie restart (genie#217).
     *
     * Deliberately a NO-OP when we already hold a buffer for `id`: the live tap is
     * authoritative, and overwriting it with a separately-trimmed copy of the same
     * stream would duplicate output and rewind the cursor under a reader. Returns
     * true when it actually seeded.
     */
    seed(id: string, scrollback: string): boolean {
        if (!scrollback || this.entries.has(id)) return false;
        this.entries.set(id, {
            buf:
                scrollback.length > this.cap
                    ? scrollback.slice(scrollback.length - this.cap)
                    : scrollback,
            total: scrollback.length,
        });
        return true;
    }

    /**
     * Shrink a terminal's retained output to its last `bytes`, keeping the cursor
     * space intact. Used when a pty EXITS: the spec is retained (revivable) and
     * that final output is the only evidence of WHY the process died, so it must
     * outlive the pty — but only a bounded tail of it, since a dead terminal's
     * buffer would otherwise sit at full capacity until the spec is deleted.
     */
    trimToTail(id: string, bytes: number): void {
        const e = this.entries.get(id);
        if (!e) return;
        const keep = Math.max(0, bytes);
        if (e.buf.length > keep) e.buf = e.buf.slice(e.buf.length - keep);
    }

    /** Every terminal id we currently hold a buffer for (reaping/diagnostics). */
    ids(): string[] {
        return Array.from(this.entries.keys());
    }

    /** Drop a terminal's buffer (on kill) so it can't leak memory. */
    forget(id: string): void {
        this.entries.delete(id);
    }

    /** Number of buffered terminals (diagnostics/tests). */
    size(): number {
        return this.entries.size;
    }
}
