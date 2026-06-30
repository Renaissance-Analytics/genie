import type { Frame, RestRequestPayload, RestReplyPayload } from './relay-protocol';

/**
 * Multiplexes a member session's REST + events + term traffic over the single
 * relay link, tagged with the session's `sid`. Transport-agnostic — it `send`s
 * frames through an injected sink and is driven by `handle(frame)` for incoming
 * ones — so the framing logic unit-tests without a socket. RelayMemberClient
 * wires this to the real `wss` socket.
 *
 * P4.1 shape: REST is correlated by `reqId` (many concurrent); `events`/`term`
 * are a SINGLE stream per session (the relay keys local sockets by (sid,
 * channel)), so re-opening `term` switches the watched terminal. Watching
 * several terminals at once needs either a per-terminal frame key or a session
 * each — a later protocol step.
 */
export class RelayFrameMux {
    private reqSeq = 0;
    private readonly pendingRest = new Map<
        string,
        { resolve: (r: RestReplyPayload) => void; reject: (e: Error) => void }
    >();
    private eventsHandler: ((msg: string) => void) | null = null;
    private termHandler: ((msg: string) => void) | null = null;

    constructor(
        private readonly sid: string,
        private readonly send: (frame: Frame) => void,
    ) {}

    /** Send a REST request over the `rest` channel; resolve with the reply. */
    rest(req: RestRequestPayload): Promise<RestReplyPayload> {
        const reqId = `r${++this.reqSeq}`;
        return new Promise<RestReplyPayload>((resolve, reject) => {
            this.pendingRest.set(reqId, { resolve, reject });
            this.send({ kind: 'open', channel: 'rest', sid: this.sid, reqId, payload: req });
        });
    }

    /** Open the `/ws/events` stream; `onEvent` gets each pushed event string.
     *  Returns an unsubscribe that closes the channel. */
    openEvents(onEvent: (msg: string) => void): () => void {
        this.eventsHandler = onEvent;
        this.send({ kind: 'open', channel: 'events', sid: this.sid, payload: { path: '/ws/events' } });
        return () => {
            this.eventsHandler = null;
            this.send({ kind: 'close', channel: 'events', sid: this.sid });
        };
    }

    /** Open a `/ws/term` stream for `terminalId`; `onData` gets each output
     *  chunk. Returns `send` (member input) + `close`. */
    openTerm(
        terminalId: string,
        onData: (msg: string) => void,
    ): { send: (input: string) => void; close: () => void } {
        this.termHandler = onData;
        this.send({
            kind: 'open',
            channel: 'term',
            sid: this.sid,
            payload: { path: `/ws/term?terminal=${encodeURIComponent(terminalId)}` },
        });
        return {
            send: (input: string) =>
                this.send({ kind: 'data', channel: 'term', sid: this.sid, payload: input }),
            close: () => {
                this.termHandler = null;
                this.send({ kind: 'close', channel: 'term', sid: this.sid });
            },
        };
    }

    /** Dispatch an incoming frame to its waiter/handler. */
    handle(frame: Frame): void {
        if (frame.channel === 'rest') {
            if (!frame.reqId) return;
            const p = this.pendingRest.get(frame.reqId);
            if (!p) return;
            this.pendingRest.delete(frame.reqId);
            if (frame.kind === 'error') {
                p.reject(new Error(frame.reason || frame.code || 'relay REST error'));
            } else {
                p.resolve((frame.payload ?? {}) as RestReplyPayload);
            }
            return;
        }
        if (frame.channel === 'events') {
            if (frame.kind === 'data' && typeof frame.payload === 'string') {
                this.eventsHandler?.(frame.payload);
            }
            return;
        }
        if (frame.channel === 'term') {
            if (frame.kind === 'data' && typeof frame.payload === 'string') {
                this.termHandler?.(frame.payload);
            }
            // close/error: the stream is gone; the handler stops receiving.
            return;
        }
    }

    /** Fail every in-flight REST request (the link dropped). */
    rejectAll(reason: string): void {
        for (const [, p] of this.pendingRest) p.reject(new Error(reason));
        this.pendingRest.clear();
        this.eventsHandler = null;
        this.termHandler = null;
    }
}
