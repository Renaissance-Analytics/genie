/**
 * THE PAGE SPAN OF A NATIVE INTERVAL (Tynn #917). local-door-cdp.mjs compares what the native socket SENT on the app's
 * connection in an interval with what the page RECEIVED in it. Its two counters cannot be read at one instant: the
 * socket's lives in main, the page's in the renderer, and pushes (local-snapshot, local-headroom) keep coming. Read one
 * after the other, a push sent between the two reads is on one side only, and the row failed on it (measured: "native
 * 26, page 27", the extra frame a local-snapshot the page received after the socket's end count was read).
 *
 * So the interval is the socket's: from its frame `nativeFrom` to its frame `nativeTo` (counts read from the socket), and
 * the page's side of it is found by each frame's ordinal on its connection (`n`, the n-th frame the page received on that
 * handle, which is the n-th the socket sent on it: one connection's frames arrive in order). The span is in the page's
 * own sequence numbers, so frames of any other handle the page received in between are still inside it, and still fail
 * the check.
 *
 * @param {ReadonlyArray<{ seq: number, handle: string, n: number }>} frames the page's records (any handles, any order)
 * @param {string} handle the app connection's handle on the page
 * @param {number} nativeFrom the socket's frame count at the interval's start
 * @param {number} nativeTo the socket's frame count at its end
 * @returns {{ from: number, to: number } | null} page seqs (from, to], or null while frame `nativeTo` has not arrived
 */
export function pageSpan(frames, handle, nativeFrom, nativeTo) {
    if (!(Number.isSafeInteger(nativeFrom) && Number.isSafeInteger(nativeTo) && nativeFrom >= 0 && nativeTo >= nativeFrom)) {
        throw new Error(`a native interval is two counts, the end not before the start (${nativeFrom} -> ${nativeTo})`);
    }
    const on = frames.filter((f) => f.handle === handle);
    const at = (n) => on.find((f) => f.n === n);
    const end = nativeTo === 0 ? null : at(nativeTo);
    if (nativeTo > 0 && !end) return null;
    if (nativeFrom === 0) {
        const first = at(1);
        if (nativeTo === 0) return { from: 0, to: 0 };
        if (!first) throw new Error(`the page's frame 1 on its connection is no longer held: the span cannot start there`);
        return { from: first.seq - 1, to: end.seq };
    }
    const start = at(nativeFrom);
    if (!start) throw new Error(`the page's frame ${nativeFrom} on its connection is no longer held: the span cannot start there`);
    return { from: start.seq, to: end.seq };
}
