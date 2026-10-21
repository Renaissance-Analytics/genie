/**
 * AT MOST ONE FLUSH PER KEY PER INTERVAL, THE LAST STATE WINS.
 *
 * A busy agent changes many times a second — every tool update, every chunk of a streamed reply — and whatever main did per
 * change (the window's detail, the Dashboard's snapshot, the tray) it did that many times (the owner, 2026-10-20: "severe
 * UI lag"). Through this the first change of a quiet key goes AT ONCE (nothing waits on a lone event), and the changes
 * after it inside the interval become ONE flush at its end. The flush reads the state then, so nothing is lost: the last
 * change is always followed by a flush that sees it.
 */
export class Coalescer<K> {
    readonly #interval: number;
    readonly #flush: (key: K) => void;
    readonly #schedule: (ms: number, fn: () => void) => () => void;
    readonly #now: () => number;
    readonly #last = new Map<K, number>();
    readonly #pending = new Map<K, () => void>();

    constructor(options: { intervalMs: number; flush: (key: K) => void; schedule: (ms: number, fn: () => void) => () => void; now: () => number }) {
        this.#interval = options.intervalMs;
        this.#flush = options.flush;
        this.#schedule = options.schedule;
        this.#now = options.now;
    }

    /** `key` changed. */
    request(key: K): void {
        if (this.#pending.has(key)) return;
        const last = this.#last.get(key);
        const wait = last === undefined ? 0 : last + this.#interval - this.#now();
        if (wait <= 0) {
            this.#run(key);
            return;
        }
        this.#pending.set(key, this.#schedule(wait, () => {
            this.#pending.delete(key);
            this.#run(key);
        }));
    }

    /** Flush `key` now if a flush is waiting (and drop the wait). */
    flushNow(key: K): void {
        const cancel = this.#pending.get(key);
        if (cancel === undefined) return;
        cancel();
        this.#pending.delete(key);
        this.#run(key);
    }

    /** Forget `key`: a waiting flush is dropped, and its next change goes at once. */
    forget(key: K): void {
        this.#pending.get(key)?.();
        this.#pending.delete(key);
        this.#last.delete(key);
    }

    /** Drop every waiting flush (a quit). */
    stop(): void {
        for (const cancel of this.#pending.values()) cancel();
        this.#pending.clear();
    }

    #run(key: K): void {
        this.#last.set(key, this.#now());
        this.#flush(key);
    }
}

/** The real timer, unreferenced so a waiting flush never keeps a process alive. */
export function realSchedule(ms: number, fn: () => void): () => void {
    const t = setTimeout(fn, Math.max(0, ms));
    (t as { unref?: () => void }).unref?.();
    return () => clearTimeout(t);
}
