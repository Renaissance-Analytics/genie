import type { WebSocket } from 'ws';

/**
 * Terminal WS bridge for the mobile `/ws/term` channel — the inverse of the
 * renderer's XTerm component, streaming a pty's bytes to a phone and feeding the
 * phone's input back to the pty.
 *
 * Wiring (no new pty subscription): ipc.ts's EXISTING onData fan-out adds one
 * line — `mobileTermFanout(id, data)` — next to `agentReadBuffer.append`, and
 * onExit adds `mobileTermClose(id)`. So this module never re-calls
 * subscribeBackendEvents (that handler set is already consumed); it just taps the
 * stream Genie already produces. Input/resize/catch-up are driven by the server,
 * which calls writeToTerminal / resize / getScrollback (injected, so this module
 * stays pty- and electron-free and unit-testable).
 *
 * BACKPRESSURE (the real risk — a chatty TUI can outrun a phone on cellular):
 * each socket has a CoalesceBuffer. Sends are gated by ws.bufferedAmount; past
 * the high-water mark we accumulate into a bounded tail buffer (reusing the
 * read-buffer cap + `dropped` semantics) and flush on drain, marking `dropped`
 * when the cap evicted bytes. onData is batched on a ~16–30 ms timer so a burst
 * of tiny writes becomes one frame.
 */

/** Max bytes we let pile up in ws's own outgoing buffer before we coalesce. */
export const WS_HIGH_WATER = 1 << 20; // 1 MiB
/** Max bytes the coalesce tail buffer retains; older bytes age out (dropped). */
export const COALESCE_CAP = 256 * 1024; // 256 KiB, matching read-buffer

/**
 * A bounded, drop-aware coalescing buffer for one terminal socket. Pure (no ws,
 * no pty) so the cap + dropped semantics are unit-tested directly.
 *
 * - `push(data)` appends; if the total exceeds the cap, the OLDEST bytes are
 *   evicted and `dropped` latches true so the next drain can tell the phone it
 *   missed output.
 * - `drain()` returns the held bytes + whether anything was dropped, and clears
 *   the buffer (and the dropped flag) for the next round.
 */
export class CoalesceBuffer {
    private buf = '';
    private droppedFlag = false;
    private readonly cap: number;

    constructor(cap: number = COALESCE_CAP) {
        this.cap = cap > 0 ? cap : COALESCE_CAP;
    }

    /** Append a chunk; trim to the cap, latching `dropped` if bytes were evicted. */
    push(data: string): void {
        if (!data) return;
        const combined = this.buf + data;
        if (combined.length > this.cap) {
            this.buf = combined.slice(combined.length - this.cap);
            this.droppedFlag = true;
        } else {
            this.buf = combined;
        }
    }

    /** True when there's buffered output waiting to flush. */
    get hasPending(): boolean {
        return this.buf.length > 0;
    }

    /** Take everything buffered + the dropped flag, and reset for the next round. */
    drain(): { data: string; dropped: boolean } {
        const out = { data: this.buf, dropped: this.droppedFlag };
        this.buf = '';
        this.droppedFlag = false;
        return out;
    }
}

/** The wire messages the server sends DOWN a `/ws/term` socket. */
export type TermDownMessage =
    | { type: 'data'; data: string }
    | { type: 'dropped' } // sent before a data frame that follows evicted bytes
    | { type: 'exit'; exitCode?: number; signal?: number };

interface SocketEntry {
    ws: WebSocket;
    buffer: CoalesceBuffer;
    /** Pending batch timer handle, or null when idle. */
    timer: ReturnType<typeof setTimeout> | null;
}

/** terminalId → the set of attached phone sockets (multi-attach allowed). */
const byTerminal = new Map<string, Set<SocketEntry>>();
/** ws → its entry, for O(1) detach + per-socket buffer access. */
const bySocket = new WeakMap<WebSocket, SocketEntry>();

/**
 * terminalId → the largest grid the bridge has ever driven the pty to. The
 * pty is SHARED with the desktop window, which fits to its OWN (usually much
 * wider) viewport and resizes the pty directly via `terminalManager().resize`
 * — a path the bridge never sees. So a phone in a narrow viewport must NOT be
 * allowed to shrink that shared pty, or the desktop terminal reflows down to
 * the phone's width (the reported bug).
 *
 * The rule (see `mobileTermResize`): the bridge only ever GROWS the pty. It
 * forwards a phone resize only when it would make the grid bigger than
 * anything the bridge has driven so far; a request that's the same or smaller
 * is dropped. Because the bridge can't observe the desktop's own resizes, the
 * floor only reflects bridge-driven sizes — but "never shrink" means the worst
 * a phone can do is leave the pty at the desktop's size (the phone scrolls
 * horizontally for the slack), which is exactly the viewer-only contract.
 */
const ptyGrowFloor = new Map<string, { cols: number; rows: number }>();

/** ~20 ms batching window — coalesces a burst of tiny pty writes into one frame. */
const BATCH_MS = 20;

/** Send a JSON message down a socket, guarded. */
function sendDown(ws: WebSocket, msg: TermDownMessage): void {
    if (ws.readyState !== 1) return; // 1 === OPEN
    try {
        ws.send(JSON.stringify(msg));
    } catch {
        /* socket went away — the close handler drops it */
    }
}

/** Flush a socket's coalesce buffer if ws has drained below the high-water mark. */
function flush(entry: SocketEntry): void {
    entry.timer = null;
    const { ws, buffer } = entry;
    if (ws.readyState !== 1) return;
    if (!buffer.hasPending) return;
    // Respect ws backpressure: if its outgoing buffer is still high, wait for
    // the next batch tick rather than piling on.
    if (ws.bufferedAmount > WS_HIGH_WATER) {
        scheduleFlush(entry);
        return;
    }
    const { data, dropped } = buffer.drain();
    if (dropped) sendDown(ws, { type: 'dropped' });
    if (data) sendDown(ws, { type: 'data', data });
}

function scheduleFlush(entry: SocketEntry): void {
    if (entry.timer) return;
    entry.timer = setTimeout(() => flush(entry), BATCH_MS);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
}

/**
 * Attach a phone socket to a terminal's byte stream. The server calls this on a
 * validated `/ws/term?terminal=<id>` upgrade AFTER sending catch-up scrollback.
 * Returns a detach fn the server binds to the socket's close.
 */
export function attachTerminalSocket(terminalId: string, ws: WebSocket): () => void {
    const entry: SocketEntry = { ws, buffer: new CoalesceBuffer(), timer: null };
    let set = byTerminal.get(terminalId);
    if (!set) {
        set = new Set();
        byTerminal.set(terminalId, set);
    }
    set.add(entry);
    bySocket.set(ws, entry);

    return () => {
        if (entry.timer) clearTimeout(entry.timer);
        const s = byTerminal.get(terminalId);
        if (s) {
            s.delete(entry);
            if (s.size === 0) byTerminal.delete(terminalId);
        }
        bySocket.delete(ws);
    };
}

/**
 * Fan one chunk of pty output out to every attached phone socket. Wired from
 * ipc.ts's existing onData (one added line). Batched per socket via the coalesce
 * buffer so a burst becomes a single frame and a slow phone can't stall the pty.
 */
export function mobileTermFanout(terminalId: string, data: string): void {
    const set = byTerminal.get(terminalId);
    if (!set || set.size === 0) return;
    for (const entry of set) {
        entry.buffer.push(data);
        scheduleFlush(entry);
    }
}

/**
 * Decide whether a phone's requested grid should be pushed to the SHARED pty.
 * Pure (no pty, no ws) so the grow-only rule is unit-tested directly.
 *
 * Returns the cols/rows to actually apply when the request would grow the pty
 * beyond every size the bridge has driven for this terminal so far, or null
 * when it would shrink (or merely match) it — in which case the caller must
 * NOT resize, leaving the shared pty at the desktop's size.
 *
 * "Grow" is per-axis-aware: we keep the max of each axis independently and
 * apply when EITHER axis would increase, so a phone that's taller-but-narrower
 * still gets more rows without ever clipping the desktop's columns.
 */
export function nextPtyGrid(
    terminalId: string,
    cols: number,
    rows: number,
): { cols: number; rows: number } | null {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
    if (cols <= 0 || rows <= 0) return null;
    const floor = ptyGrowFloor.get(terminalId);
    const nextCols = floor ? Math.max(floor.cols, cols) : cols;
    const nextRows = floor ? Math.max(floor.rows, rows) : rows;
    // No growth on either axis → don't touch the shared pty.
    if (floor && nextCols === floor.cols && nextRows === floor.rows) return null;
    ptyGrowFloor.set(terminalId, { cols: nextCols, rows: nextRows });
    return { cols: nextCols, rows: nextRows };
}

/**
 * The pty exited — push a final `exit` frame to every attached phone socket and
 * drop the terminal's set. Wired from ipc.ts's existing onExit (one added line).
 * VIEWER-ONLY: we never kill the pty here; we only tear down the phone view.
 */
export function mobileTermClose(
    terminalId: string,
    payload?: { exitCode?: number; signal?: number },
): void {
    const set = byTerminal.get(terminalId);
    if (!set) return;
    for (const entry of set) {
        if (entry.timer) clearTimeout(entry.timer);
        // Flush any tail synchronously, then the exit marker.
        const { data, dropped } = entry.buffer.drain();
        if (dropped) sendDown(entry.ws, { type: 'dropped' });
        if (data) sendDown(entry.ws, { type: 'data', data });
        sendDown(entry.ws, { type: 'exit', ...payload });
    }
    byTerminal.delete(terminalId);
    // The pty is gone — a future pty reusing this id starts from a clean floor.
    ptyGrowFloor.delete(terminalId);
}

/** Number of terminals with at least one attached phone socket (diagnostics). */
export function attachedTerminalCount(): number {
    return byTerminal.size;
}

/** Reset module state (test-only). */
export function _resetBridgeForTest(): void {
    for (const set of byTerminal.values()) {
        for (const entry of set) if (entry.timer) clearTimeout(entry.timer);
    }
    byTerminal.clear();
    ptyGrowFloor.clear();
}
