import type { LineStream } from './spawn-exec.js';

/** What Hosting says while genie-host's process helper (its `supervised` spawn-host child) is down. */
export const LIVE_STATUS_PAUSED = 'Live service status is paused: Genie’s process helper isn’t running';

/**
 * A LINE STREAM STARTED UNDER A SPAWN-HOST CHILD, ONCE THAT CHILD IS UP (one owner for every process genie-host starts).
 * genie-host's spawn-host children come up after its boot has begun; a stream asked for before then (the Docker driver's
 * `docker events` watch, at composition) waits for the link instead of being refused — and is started there, so the child
 * ends it when its parent link closes (spawn-host.ts). A link that goes down ends the streams it carried (the client
 * says so), and whoever watched asks again; that ask waits for the next link.
 */
export function streamWhenLinked(stream: LineStream, link: { readonly up: () => boolean; readonly onUp: (listener: () => void) => () => void }): LineStream {
    return (binary, args, onLine, onEnd) => {
        if (link.up()) return stream(binary, args, onLine, onEnd);
        let started: { stop(): void } | null = null;
        let stopped = false;
        const off = link.onUp(() => {
            off();
            if (stopped) return;
            started = stream(binary, args, onLine, onEnd);
        });
        return {
            stop: () => {
                stopped = true;
                off();
                started?.stop();
            },
        };
    };
}

/**
 * A SPAWN-HOST CHILD'S LINK, AS THE HOST TRACKS IT: up once the child is ready and reconciled, down when it exits (or
 * never came up). Streams started through it wait for it; while it is down, the hosting SAYS so (LIVE_STATUS_PAUSED in
 * Hosting's problems) — the engines' live status is not silently stale — and the line clears when it returns.
 */
export class LinkGate {
    #up = false;
    readonly #listeners = new Set<() => void>();

    up(): boolean {
        return this.#up;
    }

    setUp(up: boolean): void {
        if (this.#up === up) return;
        this.#up = up;
        for (const l of [...this.#listeners]) { try { l(); } catch { /* one listener never costs another */ } }
    }

    /** Fires on every change, up or down. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** `stream`, started only while this link is up (asked while down: started when it comes up). */
    stream(stream: LineStream): LineStream {
        return streamWhenLinked(stream, {
            up: () => this.#up,
            onUp: (listener) => this.onChange(() => { if (this.#up) listener(); }),
        });
    }
}
