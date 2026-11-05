import type { LineStream } from './spawn-exec.js';

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
