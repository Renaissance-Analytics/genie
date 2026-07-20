import {
    readSiteInbound,
    type Frame,
    type RestRequestPayload,
    type RestReplyPayload,
    type SiteOpenPayload,
} from './relay-protocol';

/** The callbacks a site-proxy stream owner (the relay {@link SiteCarrier}) wires
 *  to receive the host's streamed response over the `site` channel. */
export interface SiteStreamHandlers {
    /** HTTP response head — status + headers, before any body chunk. */
    onResponse?: (status: number, headers: Record<string, string | string[]>) => void;
    /** WS `upgrade` established (101) — before bidirectional data chunks. */
    onUpgrade?: (status: number, statusText: string, headers: Record<string, string | string[]>) => void;
    /** A body / WS server→client chunk. */
    onData?: (chunk: Buffer) => void;
    /** The stream ended cleanly (response complete / socket closed). */
    onClose?: () => void;
    /** The stream failed (upstream error / link dropped). */
    onError?: (message: string) => void;
}

/** The handle to drive one open site-proxy stream (request body / WS input). */
export interface SiteStreamController {
    /** Send a request-body / WS client→server chunk. */
    write(chunk: Buffer): void;
    /** Signal the request body is complete (HTTP half-close). No-op after close. */
    end(): void;
    /** Close the whole stream (client aborted / done). Idempotent. */
    close(): void;
}

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
    /**
     * Live term streams keyed by their `reqId`, so a workstation can drive MANY
     * terminals at once — the same shape `siteStreams` has always had. This was a
     * single handler, which is why only the most-recently-attached terminal
     * streamed and every other one went dead.
     *
     * The empty-string key is the LEGACY stream: a host proxy without
     * `termMultiplex` keys everything as `sid:term`, so we open exactly one
     * un-keyed stream and route its (reqId-less) frames here.
     */
    private readonly termStreams = new Map<string, (msg: string) => void>();
    /** Concurrent site-proxy streams, keyed by reqId (Phase E). Unlike
     *  events/term (single-stream), a page load runs many at once. */
    private readonly siteStreams = new Map<string, SiteStreamHandlers>();

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
     *  chunk. Returns `send` (member input) + `close`.
     *
     *  `workspaceId` (optional) names the terminal's workspace so the host can
     *  scope the term against the grant's workspaces (a workspace-scoped grant
     *  opens ONLY its own terminals; `host:all` opens any). Additive + wire-
     *  compatible: an old host ignores the field, and a term opened WITHOUT it
     *  (system/unattached terminal, or an old member) fails closed to `host:all`
     *  on the host side. */
    /**
     * `multiplex` reflects the HOST proxy's advertised `termMultiplex` capability
     * (see RELAY_FEATURES_PATH). With it, each stream gets its own `reqId` and many
     * terminals run concurrently. Without it the host would key every stream as
     * `sid:term` and a second concurrent open would silently collide, so we stay on
     * one un-keyed legacy stream — the caller is responsible for keeping to one.
     */
    openTerm(
        terminalId: string,
        onData: (msg: string) => void,
        workspaceId?: string,
        multiplex = false,
    ): { send: (input: string) => void; close: () => void } {
        const reqId = multiplex ? `t${++this.reqSeq}` : '';
        const tag = reqId ? { reqId } : {};
        this.termStreams.set(reqId, onData);
        this.send({
            kind: 'open',
            channel: 'term',
            sid: this.sid,
            ...tag,
            payload: {
                // `client=desktop` — the only caller here is a remote Genie window,
                // so the host sizes the pty to our grid exactly rather than applying
                // the phone viewer's grow-only clamp.
                path: `/ws/term?terminal=${encodeURIComponent(terminalId)}&client=desktop`,
                ...(workspaceId ? { workspaceId } : {}),
            },
        });
        return {
            send: (input: string) =>
                this.send({ kind: 'data', channel: 'term', sid: this.sid, ...tag, payload: input }),
            close: () => {
                this.termStreams.delete(reqId);
                this.send({ kind: 'close', channel: 'term', sid: this.sid, ...tag });
            },
        };
    }

    /**
     * Open a site-proxy stream over the `site` channel (Phase E): send the
     * `open` (an HTTP request or a WS `upgrade`), stream request-body / WS-input
     * via the returned controller, and receive the host's streamed response
     * through `handlers`. Mirrors `openTerm`'s streaming shape, but keyed by a
     * fresh `reqId` so many run concurrently.
     */
    openSite(open: SiteOpenPayload, handlers: SiteStreamHandlers): SiteStreamController {
        const reqId = `s${++this.reqSeq}`;
        this.siteStreams.set(reqId, handlers);
        this.send({ kind: 'open', channel: 'site', sid: this.sid, reqId, payload: open });
        let live = true;
        return {
            write: (chunk: Buffer) => {
                if (!live) return;
                this.send({
                    kind: 'data',
                    channel: 'site',
                    sid: this.sid,
                    reqId,
                    payload: { t: 'body', data: chunk.toString('base64') },
                });
            },
            end: () => {
                if (!live) return;
                this.send({ kind: 'data', channel: 'site', sid: this.sid, reqId, payload: { t: 'end' } });
            },
            close: () => {
                if (!live) return;
                live = false;
                this.siteStreams.delete(reqId);
                this.send({ kind: 'close', channel: 'site', sid: this.sid, reqId });
            },
        };
    }

    /** Dispatch an incoming frame to its waiter/handler. */
    handle(frame: Frame): void {
        if (frame.channel === 'site') {
            if (!frame.reqId) return;
            const h = this.siteStreams.get(frame.reqId);
            if (!h) return; // unknown/closed stream — drop
            if (frame.kind === 'error') {
                this.siteStreams.delete(frame.reqId);
                h.onError?.(frame.reason || frame.code || 'relay site error');
                return;
            }
            if (frame.kind === 'close') {
                this.siteStreams.delete(frame.reqId);
                h.onClose?.();
                return;
            }
            if (frame.kind === 'data') {
                const inbound = readSiteInbound(frame);
                if (!inbound) return;
                if (inbound.t === 'response') h.onResponse?.(inbound.status, inbound.headers);
                else if (inbound.t === 'upgraded') h.onUpgrade?.(inbound.status, inbound.statusText, inbound.headers);
                else h.onData?.(inbound.chunk);
            }
            return;
        }
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
                // Route by the stream's reqId. A host that echoes none is the legacy
                // single-stream proxy, whose frames belong to the '' stream.
                this.termStreams.get(frame.reqId ?? '')?.(frame.payload);
            }
            // close/error: the stream is gone; the handler stops receiving.
            return;
        }
    }

    /** Fail every in-flight REST request + site stream (the link dropped). */
    rejectAll(reason: string): void {
        for (const [, p] of this.pendingRest) p.reject(new Error(reason));
        this.pendingRest.clear();
        for (const [, h] of this.siteStreams) h.onError?.(reason);
        this.siteStreams.clear();
        this.eventsHandler = null;
        this.termStreams.clear();
    }
}
