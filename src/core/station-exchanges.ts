/**
 * AN EXCHANGE WITH ANOTHER WORKSTATION, WHILE IT GOES ON (P9; the owner, 2026-11-25: "there is a visual display in the genie
 * header during the exchange on the right side. The right side of the header is for host related data like machine name,
 * and incoming activity"). Pure. genie-host's cross-station mail says when one begins and ends (a link it opened to
 * send) or that one happened (mail another station handed it); this keeps what is going on now, by station, with the
 * direction, and keeps each on screen a moment after it ends so a person can see it at all.
 */

export type ExchangeDirection = 'in' | 'out' | 'both';

export interface StationExchange {
    /** The other workstation's Tynn id. */
    readonly station: string;
    /** Its name, as a person reads it. */
    readonly name: string;
    readonly direction: ExchangeDirection;
}

interface Live { name: string; out: number; in: number; lingerOut: boolean; lingerIn: boolean; cancel: (() => void) | null }

export const EXCHANGE_LINGER_MS = 4_000;

export class StationExchanges {
    readonly #live = new Map<string, Live>();
    readonly #listeners = new Set<() => void>();
    readonly #schedule: (ms: number, fn: () => void) => () => void;
    readonly #lingerMs: number;

    constructor(options: { now?: () => number; schedule?: (ms: number, fn: () => void) => () => void; lingerMs?: number } = {}) {
        this.#schedule = options.schedule ?? ((ms, fn) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return () => clearTimeout(t); });
        this.#lingerMs = options.lingerMs ?? EXCHANGE_LINGER_MS;
    }

    /** An exchange begins (a link opened to send). The answer ends it; ending twice is once. */
    begin(station: string, name: string, direction: 'in' | 'out'): () => void {
        const live = this.#entry(station, name);
        live[direction] += 1;
        this.#changed();
        let ended = false;
        return () => {
            if (ended) return;
            ended = true;
            live[direction] -= 1;
            if (live[direction] === 0) this.#linger(station, direction);
        };
    }

    /** One crossing (mail handed here): shown, then cleared by itself. */
    pulse(station: string, name: string, direction: 'in' | 'out'): void {
        this.#entry(station, name);
        this.#changed();
        this.#linger(station, direction);
    }

    view(): StationExchange[] {
        const out: StationExchange[] = [];
        for (const [station, l] of this.#live) {
            const goingIn = l.in > 0 || l.lingerIn;
            const goingOut = l.out > 0 || l.lingerOut;
            if (!goingIn && !goingOut) continue;
            out.push({ station, name: l.name, direction: goingIn && goingOut ? 'both' : goingIn ? 'in' : 'out' });
        }
        return out;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #entry(station: string, name: string): Live {
        let live = this.#live.get(station);
        if (!live) { live = { name, out: 0, in: 0, lingerOut: false, lingerIn: false, cancel: null }; this.#live.set(station, live); }
        live.name = name;
        return live;
    }

    #linger(station: string, direction: 'in' | 'out'): void {
        const live = this.#live.get(station);
        if (!live) return;
        if (direction === 'in') live.lingerIn = true; else live.lingerOut = true;
        live.cancel?.();
        live.cancel = this.#schedule(this.#lingerMs, () => {
            live.cancel = null;
            live.lingerIn = false;
            live.lingerOut = false;
            if (live.in === 0 && live.out === 0) this.#live.delete(station);
            this.#changed();
        });
    }

    #changed(): void {
        for (const l of [...this.#listeners]) l();
    }
}

/** What came over the wire, as a list; anything that does not read is dropped (fail closed). */
export function readStationExchanges(raw: unknown): StationExchange[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((r): StationExchange[] => {
        const e = r as Record<string, unknown> | null;
        if (!e || typeof e !== 'object' || typeof e.station !== 'string' || typeof e.name !== 'string') return [];
        if (e.direction !== 'in' && e.direction !== 'out' && e.direction !== 'both') return [];
        return [{ station: e.station, name: e.name, direction: e.direction }];
    });
}
