import type { MailpitSummary } from './mailpit-reader.js';

/**
 * THE HOST'S SUBSCRIPTION TO THE SHARED MAILPIT'S WEBSOCKET (Genie Mail G7, Tynn #493). Mailpit pushes a `new` event with
 * the message's summary as it takes each message (G1 measured it: test/mailpit-measure/mailpit-v130.accept.ts), so a
 * `mail wait` is answered from here, never by polling.
 *
 * One socket, opened on the first listener and closed on the last: nothing stays connected while nobody waits. A socket
 * that will not open (or closes before opening) rejects its listeners' `ready`, so a wait says so instead of waiting
 * blind; a socket that closes later is opened again for the listeners still there.
 */
export interface EventSocket {
    addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
    close(): void;
}
export type SocketFactory = (url: string) => EventSocket;

export interface MailEventsSubscription {
    /** Resolves once the socket is open: a message taken after this reaches the listener. */
    readonly ready: Promise<void>;
    close(): void;
}

export interface MailEventsSource {
    subscribe(listener: (message: MailpitSummary) => void): MailEventsSubscription;
}

interface Waiter { readonly listener: (message: MailpitSummary) => void; resolve(): void; reject(error: Error): void; settled: boolean }

const defaultConnect: SocketFactory = (url) => new WebSocket(url) as unknown as EventSocket;

/** Mailpit's API base (http://127.0.0.1:<port>) to its events socket. */
export function eventsUrlOf(apiUrl: string): string {
    return `${apiUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/events`;
}

export class MailpitEvents implements MailEventsSource {
    readonly #url: () => string | null;
    readonly #connect: SocketFactory;
    readonly #retryMs: number;
    readonly #waiters = new Set<Waiter>();
    #socket: EventSocket | null = null;
    #open = false;
    #retry: ReturnType<typeof setTimeout> | null = null;

    constructor(input: { url: () => string | null; connect?: SocketFactory; retryMs?: number }) {
        this.#url = input.url;
        this.#connect = input.connect ?? defaultConnect;
        this.#retryMs = input.retryMs ?? 1000;
    }

    /** How many are listening (tests). */
    listeners(): number {
        return this.#waiters.size;
    }

    subscribe(listener: (message: MailpitSummary) => void): MailEventsSubscription {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const ready = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
        // A `ready` nobody awaits (the caller closed first) must not surface as an unhandled rejection.
        ready.catch(() => undefined);
        const waiter: Waiter = { listener, resolve: () => { waiter.settled = true; resolve(); }, reject: (e) => { waiter.settled = true; reject(e); }, settled: false };
        this.#waiters.add(waiter);
        if (this.#open) waiter.resolve();
        else if (!this.#socket) this.#start();
        return {
            ready,
            close: () => {
                this.#waiters.delete(waiter);
                if (this.#waiters.size === 0) this.#stop();
            },
        };
    }

    #start(): void {
        const api = this.#url();
        if (!api) {
            for (const w of this.#waiters) if (!w.settled) w.reject(new Error("Genie's shared Mailpit is not there, so there is nothing to wait on"));
            return;
        }
        let socket: EventSocket;
        try {
            socket = this.#connect(eventsUrlOf(api));
        } catch (error) {
            for (const w of this.#waiters) if (!w.settled) w.reject(new Error(`Mailpit's websocket could not be opened: ${error instanceof Error ? error.message : String(error)}`));
            return;
        }
        this.#socket = socket;
        socket.addEventListener('open', () => {
            if (this.#socket !== socket) return;
            this.#open = true;
            for (const w of this.#waiters) if (!w.settled) w.resolve();
        });
        socket.addEventListener('message', (event: { data?: unknown }) => {
            if (this.#socket !== socket) return;
            let parsed: { Type?: unknown; Data?: unknown };
            try { parsed = JSON.parse(typeof event?.data === 'string' ? event.data : String(event?.data)) as typeof parsed; } catch { return; }
            if (parsed.Type !== 'new' || !parsed.Data || typeof parsed.Data !== 'object') return;
            for (const w of [...this.#waiters]) w.listener(parsed.Data as MailpitSummary);
        });
        socket.addEventListener('close', () => {
            if (this.#socket !== socket) return;
            const wasOpen = this.#open;
            this.#socket = null;
            this.#open = false;
            if (!wasOpen) {
                // Never opened: whoever is waiting for it is told; the next subscribe tries again.
                for (const w of this.#waiters) if (!w.settled) w.reject(new Error("Mailpit's websocket did not open"));
                return;
            }
            // Dropped after opening (Mailpit restarted to read a new inbox): opened again for the listeners still here.
            if (this.#waiters.size > 0 && !this.#retry) this.#retry = setTimeout(() => { this.#retry = null; if (this.#waiters.size > 0 && !this.#socket) this.#start(); }, this.#retryMs);
        });
        socket.addEventListener('error', () => { /* a 'close' follows; handled there */ });
    }

    #stop(): void {
        if (this.#retry) { clearTimeout(this.#retry); this.#retry = null; }
        const socket = this.#socket;
        this.#socket = null;
        this.#open = false;
        socket?.close();
    }
}
