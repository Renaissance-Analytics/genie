import type { Headroom } from './headroom.js';

/**
 * THE DASHBOARD HEADER'S RATE LIMITS, ONE PER PROVIDER (the owner, 2026-10-26: "I need a rate limit indicator in the
 * dashboard header, 1 per provider ... with a 1 min buffer to prevent ui spam if multiple agents are running ... if the
 * 1min buffer is active any other rate update is just ignored until the buffer clears"). Kept in MAIN: a reading inside
 * its provider's buffer costs one comparison and reaches nothing — no push, no render, nothing that slows an agent.
 */
export class HeadroomBoard {
    readonly #shown = new Map<string, { room: Headroom; at: number }>();

    /**
     * A provider's reading: shown (true) unless that provider's last shown reading is younger than `bufferMs`. A shown
     * reading KEEPS every window an earlier one reported that it did not repeat (genie#1268: every reported limit, not
     * only the latest frame's); a window it does repeat takes the new figure.
     */
    offer(provider: string, room: Headroom, nowMs: number, bufferMs: number): boolean {
        const last = this.#shown.get(provider);
        if (last && nowMs < last.at + bufferMs) return false;
        const named = new Set(room.windows.map((w) => w.window));
        const kept = last ? last.room.windows.filter((w) => !named.has(w.window)) : [];
        this.#shown.set(provider, { room: kept.length === 0 ? room : { ...room, windows: [...room.windows, ...kept] }, at: nowMs });
        return true;
    }

    /** What the header shows: each provider's last shown reading. */
    view(): Record<string, Headroom> {
        return Object.fromEntries([...this.#shown].map(([provider, s]) => [provider, s.room]));
    }
}

/** The buffer from the host setting `rate_limit_refresh` (seconds); 1 minute by default, and for anything not offered. */
export function headroomBufferMs(values: Readonly<Record<string, unknown>>): number {
    const seconds = Number(values['rate_limit_refresh']);
    return [30, 60, 120, 300].includes(seconds) ? seconds * 1000 : 60_000;
}
