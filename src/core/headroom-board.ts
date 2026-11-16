import { readLimitWindow, type Headroom, type ReadingStamp, type WindowReading } from './headroom.js';

/** One account's last reading as saved (Tynn #485). */
export interface SavedReading { readonly source: HeadroomSource; readonly runId: string; readonly room: Headroom }

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function savedWindow(v: unknown): Headroom['windows'][number] | null {
    if (!isRec(v) || typeof v['window'] !== 'string' || !finite(v['usedPct']) || !finite(v['leftPct']) || !finite(v['resetsAtMs']) || typeof v['over'] !== 'boolean') return null;
    return { window: v['window'], usedPct: v['usedPct'], leftPct: v['leftPct'], resetsAtMs: v['resetsAtMs'], over: v['over'] };
}
function savedReading(v: unknown): SavedReading | null {
    if (!isRec(v) || !isRec(v['source']) || !isRec(v['room'])) return null;
    const s = v['source'], r = v['room'];
    if (typeof s['provider'] !== 'string' || typeof s['accountId'] !== 'string' || !s['provider'] || !s['accountId']) return null;
    if (!Array.isArray(r['windows']) || typeof r['window'] !== 'string' || !finite(r['leftPct']) || !finite(r['resetsAtMs']) || typeof r['over'] !== 'boolean') return null;
    if (r['plan'] !== null && typeof r['plan'] !== 'string') return null;
    const windows = r['windows'].map(savedWindow);
    if (windows.some((w) => w === null)) return null;
    return { source: { provider: s['provider'], accountId: s['accountId'] }, runId: typeof v['runId'] === 'string' ? v['runId'] : '',
        room: { plan: (r['plan'] as string | null), window: r['window'], leftPct: r['leftPct'], resetsAtMs: r['resetsAtMs'], over: r['over'], windows: windows as Headroom['windows'] } };
}

/** Whose reading it is: the provider, and the account the agent was launched on. */
export interface HeadroomSource {
    readonly provider: string;
    readonly accountId: string;
}

/** One account's reading, as the host serves it. */
export interface AccountHeadroom extends HeadroomSource {
    readonly runId: string;
    readonly room: Headroom;
    readonly windows: readonly WindowReading[];
}

/**
 * THE RATE LIMITS, ONE PER ACCOUNT (Tynn #478; the owner, 2026-10-26: "I need a rate limit indicator in the
 * dashboard header, 1 per provider ... with a 1 min buffer to prevent ui spam if multiple agents are running ... if the
 * 1min buffer is active any other rate update is just ignored until the buffer clears"). Kept in genie-host: a reading
 * inside its account's buffer costs one comparison and reaches nothing — no push, no render, nothing that slows an agent.
 * Two accounts of one provider are two limits: A's reading never overwrites B's and never waits out B's buffer.
 */
export class HeadroomBoard {
    readonly #shown = new Map<string, { room: Headroom; at: number; source: HeadroomSource; runId: string }>();

    /**
     * An account's reading: shown (true) unless that account's last shown reading is younger than `bufferMs`. A shown
     * reading KEEPS every window an earlier one reported that it did not repeat (genie#1268: every reported limit, not
     * only the latest frame's); a window it does repeat takes the new figure.
     */
    offer(source: HeadroomSource, room: Headroom, nowMs: number, bufferMs: number, stamp?: ReadingStamp): boolean {
        const key = `${source.provider}:${source.accountId}`;
        const last = this.#shown.get(key);
        if (last && nowMs < last.at + bufferMs) return false;
        const named = new Set(room.windows.map((w) => w.window));
        const kept = last ? last.room.windows.filter((w) => !named.has(w.window)) : [];
        this.#shown.set(key, { room: kept.length === 0 ? room : { ...room, windows: [...room.windows, ...kept] }, at: nowMs, source, runId: stamp?.runId ?? '' });
        return true;
    }

    /** A forgotten account's readings leave the board (Tynn #484). */
    forget(accountId: string): void {
        for (const [key, s] of this.#shown) if (s.source.accountId === accountId) this.#shown.delete(key);
    }

    /** Every account's last reading, as JSON, so a host restart still knows an idle account's room (Tynn #485). */
    snapshot(): SavedReading[] {
        return [...this.#shown.values()].map((s) => ({ source: { ...s.source }, runId: s.runId, room: s.room }));
    }

    /**
     * The saved readings, back; anything that is not one is dropped. They take no buffer: the next reading of an account is shown
     * at once. A reading arriving before the restore wins over the saved one.
     */
    restore(saved: unknown): void {
        if (!Array.isArray(saved)) return;
        for (const raw of saved) {
            const r = savedReading(raw);
            if (!r) continue;
            const key = `${r.source.provider}:${r.source.accountId}`;
            if (!this.#shown.has(key)) this.#shown.set(key, { room: r.room, at: Number.NEGATIVE_INFINITY, source: r.source, runId: r.runId });
        }
    }

    /** Every account's last shown reading, each window read at `nowMs`: one past its reset time is Refreshed. */
    accounts(nowMs: number): AccountHeadroom[] {
        return [...this.#shown.values()].map((s) => ({ ...s.source, runId: s.runId, room: s.room, windows: s.room.windows.map((w) => readLimitWindow(w, nowMs)) }));
    }

    /** What the header shows until it lists accounts (S10): each provider's most recently shown reading. */
    view(): Record<string, Headroom> {
        const latest = new Map<string, { room: Headroom; at: number }>();
        for (const s of this.#shown.values()) {
            const seen = latest.get(s.source.provider);
            if (!seen || s.at >= seen.at) latest.set(s.source.provider, s);
        }
        return Object.fromEntries([...latest].map(([provider, s]) => [provider, s.room]));
    }
}

/**
 * THE BOARD, AND WHO HEARS IT (Tynn #553): what the window and genie-host each keep. A reading that clears its buffer is kept
 * and told to every listener once; one inside it costs a comparison. The buffer is asked at each reading, so a change to
 * the setting applies at once.
 */
export class HeadroomFeed {
    readonly #board = new HeadroomBoard();
    readonly #listeners = new Set<(room: Readonly<Record<string, Headroom>>) => void>();
    readonly #bufferMs: () => number;
    readonly #now: () => number;

    constructor(bufferMs: () => number, now: () => number = Date.now) {
        this.#bufferMs = bufferMs;
        this.#now = now;
    }

    offer(provider: string, room: Headroom, stamp?: ReadingStamp): void {
        if (!this.#board.offer({ provider, accountId: stamp?.accountId ?? `account_legacy_${provider}` }, room, this.#now(), this.#bufferMs(), stamp)) return;
        const view = this.#board.view();
        for (const listener of this.#listeners) listener(view);
    }

    view(): Record<string, Headroom> {
        return this.#board.view();
    }

    /** A forgotten account's readings go (Tynn #484). */
    forget(accountId: string): void {
        this.#board.forget(accountId);
    }

    /** Every account's last reading, to save (Tynn #485). */
    snapshot(): SavedReading[] {
        return this.#board.snapshot();
    }

    /** The saved readings, back after a restart (Tynn #485). Tells no listener: nothing new was read. */
    restore(saved: unknown): void {
        this.#board.restore(saved);
    }

    /** Every account's reading, each window read now (a window past its reset is Refreshed). */
    accounts(): AccountHeadroom[] {
        return this.#board.accounts(this.#now());
    }

    subscribe(listener: (room: Readonly<Record<string, Headroom>>) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}

/** The buffer from the host setting `rate_limit_refresh` (seconds); 1 minute by default, and for anything not offered. */
export function headroomBufferMs(values: Readonly<Record<string, unknown>>): number {
    const seconds = Number(values['rate_limit_refresh']);
    return [30, 60, 120, 300].includes(seconds) ? seconds * 1000 : 60_000;
}
