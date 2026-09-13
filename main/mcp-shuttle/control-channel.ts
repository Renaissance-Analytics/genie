import type net from 'node:net';
import type { DispatchFrame, ShuttleResponse } from './core';
import { isManifest, type ShuttleManifest } from './manifest-store';
import type { GateConnection, GateMessage, PublisherGate } from './publisher-gate';
import { isTopology, type ShuttleTopology } from './topology-store';

/**
 * THE CONTROL CHANNEL — the pipe a Genie publishes through.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.2 and §4.1. A named pipe
 * (Windows) or unix socket (POSIX) carrying length-prefixed JSON frames between the
 * shuttle and the Genie that publishes into it. `attachControlServer` is the
 * shuttle's end: each connection is decoded and handed to the {@link PublisherGate}.
 * `connectPublisher` is Genie's end: it says hello, runs what it is dispatched, and
 * sends the results back.
 *
 * ## Every frame is untrusted
 *
 * The pipe is reachable by any process running as this user, so nothing that
 * arrives on it is assumed to be well formed. A frame that is not a valid message,
 * or a stream whose framing has desynchronised, CLOSES THAT CONNECTION and leaves
 * the shuttle serving everyone else. A connection is closed with a `closed` frame
 * naming the reason first, so a refused Genie can say why rather than report a hung
 * pipe.
 *
 * ## The codec is injected
 *
 * The spec reuses fancy-term-host's framing, which is proven cross-platform. It
 * cannot be imported without that package's native `node-pty` until
 * Particle-Academy/fancy-term-host#12 exposes it separately, and the shuttle must
 * ship with no native dependencies. So the codec is a parameter.
 */

export interface FrameDecoderLike {
    /** Every complete message in the stream so far. An entry that did not parse is
     *  returned as `undefined` rather than skipped, so the server can refuse it. */
    push(chunk: Buffer): unknown[];
    /** True once the framing can no longer be trusted (an absurd length prefix). */
    readonly desynced: boolean;
}

export interface FrameCodec {
    encode(message: unknown): Buffer;
    /** One decoder per connection: a stream has no message boundaries. */
    decoder(): FrameDecoderLike;
}

/** Sent to a connection just before the shuttle closes it, naming why. */
export interface ClosedMessage {
    type: 'closed';
    reason: string;
}

/** What the shuttle may send a publisher. */
export type OutboundGateMessage =
    | Extract<GateMessage, { type: 'welcome' | 'displaced' | 'dispatch' }>
    | ClosedMessage;

/** What a publisher may send the shuttle. */
export type InboundGateMessage = Extract<GateMessage, { type: 'hello' | 'result' | 'publish' | 'topology' }>;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);

function isResponse(v: unknown): v is ShuttleResponse {
    if (!isRecord(v)) return false;
    if ('error' in v && v.error !== undefined) {
        const e = v.error;
        return isRecord(e) && typeof e.code === 'number' && typeof e.message === 'string';
    }
    return 'result' in v;
}

/** A publisher's message, or null for anything else — including the shuttle's own
 *  message types sent back at it. */
export function parseInboundGateMessage(raw: unknown): InboundGateMessage | null {
    if (!isRecord(raw)) return null;
    if (raw.type === 'hello') {
        if (!isInt(raw.wireGeneration) || typeof raw.secret !== 'string' || !isInt(raw.generation)) return null;
        return { type: 'hello', wireGeneration: raw.wireGeneration, secret: raw.secret, generation: raw.generation };
    }
    if (raw.type === 'result') {
        if (!isInt(raw.correlationId) || !isResponse(raw.response)) return null;
        return { type: 'result', correlationId: raw.correlationId, response: raw.response };
    }
    // The surface every agent is served, and where each URL leads. Validated by the
    // same rules the stores apply, so a publish the store would refuse never reaches it.
    if (raw.type === 'publish') {
        return isManifest(raw.manifest) ? { type: 'publish', manifest: raw.manifest } : null;
    }
    if (raw.type === 'topology') {
        return isTopology(raw.topology) ? { type: 'topology', topology: raw.topology } : null;
    }
    return null;
}

function isDispatchFrame(v: unknown): v is DispatchFrame {
    if (!isRecord(v) || !isInt(v.correlationId) || !isInt(v.generation)) return false;
    const r = v.request;
    return isRecord(r) && typeof r.method === 'string' && (typeof r.id === 'string' || typeof r.id === 'number');
}

/** The shuttle's message, or null for anything else. Genie trusts the shuttle no
 *  more than the shuttle trusts it. */
export function parseOutboundGateMessage(raw: unknown): OutboundGateMessage | null {
    if (!isRecord(raw)) return null;
    switch (raw.type) {
        case 'welcome':
            return isInt(raw.wireGeneration) ? { type: 'welcome', wireGeneration: raw.wireGeneration } : null;
        case 'displaced':
            return typeof raw.reason === 'string' ? { type: 'displaced', reason: raw.reason } : null;
        case 'closed':
            return typeof raw.reason === 'string' ? { type: 'closed', reason: raw.reason } : null;
        case 'dispatch':
            return isDispatchFrame(raw.frame) ? { type: 'dispatch', frame: raw.frame } : null;
        default:
            return null;
    }
}

/** Write a frame if the socket can still take one. A dead socket is not an error
 *  here: its `close` event is what tells the gate. */
function writeFrame(socket: net.Socket, codec: FrameCodec, message: unknown): void {
    if (socket.destroyed || !socket.writable) return;
    try {
        socket.write(codec.encode(message));
    } catch {
        /* the socket went away between the check and the write */
    }
}

/** The shuttle's end: serve publishers on `server` through `gate`. */
export function attachControlServer(server: net.Server, opts: { gate: PublisherGate; codec: FrameCodec }): void {
    const { gate, codec } = opts;

    server.on('connection', (socket) => {
        const decoder = codec.decoder();
        let ended = false;

        const conn: GateConnection = {
            send: (message) => writeFrame(socket, codec, message),
            close: (reason) => {
                if (ended) return;
                ended = true;
                writeFrame(socket, codec, { type: 'closed', reason } satisfies ClosedMessage);
                socket.end();
                // A peer that never reads must not hold the connection open.
                setTimeout(() => socket.destroy(), 1_000).unref?.();
            },
        };

        gate.connected(conn);

        socket.on('data', (chunk: Buffer) => {
            if (ended) return;
            const messages = decoder.push(chunk);
            if (decoder.desynced) {
                conn.close('The control stream is not framed correctly.');
                return;
            }
            for (const raw of messages) {
                if (ended) return;
                const message = parseInboundGateMessage(raw);
                if (!message) {
                    conn.close('The control channel received something that is not a message.');
                    return;
                }
                gate.message(conn, message);
            }
        });

        let closedOnce = false;
        const onGone = () => {
            if (closedOnce) return;
            closedOnce = true;
            ended = true;
            gate.closed(conn);
        };
        socket.on('close', onGone);
        socket.on('error', onGone);
    });
}

export interface PublisherOptions {
    connect: () => net.Socket;
    codec: FrameCodec;
    secret: string;
    wireGeneration: number;
    /** Monotonic per Genie boot. */
    generation: number;
    /** Run one dispatched request. Must not reject; `runDispatch` never does. */
    run: (frame: DispatchFrame) => Promise<ShuttleResponse>;
    onWelcome?: () => void;
    /** A newer Genie took over. The shuttle closes this connection next. */
    onDisplaced?: (reason: string) => void;
    /** The connection ended. `reason` is the shuttle's when it gave one. */
    onClosed?: (reason: string) => void;
}

/** Genie's end of the control channel. */
export interface PublisherConnection {
    /**
     * Send the surface every agent is served. Before the shuttle has welcomed
     * this connection it is HELD and only the latest is sent, once welcomed — the
     * gate closes a connection whose first message is not hello, so a boot-time
     * publish sent straight away would get Genie thrown off its own shuttle.
     */
    publish(manifest: ShuttleManifest): void;
    /** Send where each URL token leads. Held and sent like {@link publish}. */
    topology(topology: ShuttleTopology): void;
    close(): void;
}

/** Genie's end: publish into the shuttle until closed or displaced. */
export function connectPublisher(opts: PublisherOptions): PublisherConnection {
    const socket = opts.connect();
    const decoder = opts.codec.decoder();
    let reason: string | null = null;
    let finished = false;
    let welcomed = false;
    /** The latest of each, given before the welcome. */
    const held: { manifest?: ShuttleManifest; topology?: ShuttleTopology } = {};

    const sendManifest = (manifest: ShuttleManifest) =>
        writeFrame(socket, opts.codec, { type: 'publish', manifest } satisfies InboundGateMessage);
    const sendTopology = (topology: ShuttleTopology) =>
        writeFrame(socket, opts.codec, { type: 'topology', topology } satisfies InboundGateMessage);

    socket.on('connect', () => {
        writeFrame(socket, opts.codec, {
            type: 'hello',
            wireGeneration: opts.wireGeneration,
            secret: opts.secret,
            generation: opts.generation,
        } satisfies InboundGateMessage);
    });

    socket.on('data', (chunk: Buffer) => {
        const messages = decoder.push(chunk);
        if (decoder.desynced) {
            reason = 'The shuttle’s control stream is not framed correctly.';
            socket.destroy();
            return;
        }
        for (const raw of messages) {
            const message = parseOutboundGateMessage(raw);
            if (!message) {
                reason = 'The shuttle sent something that is not a message.';
                socket.destroy();
                return;
            }
            switch (message.type) {
                case 'welcome':
                    welcomed = true;
                    if (held.manifest) sendManifest(held.manifest);
                    if (held.topology) sendTopology(held.topology);
                    delete held.manifest;
                    delete held.topology;
                    opts.onWelcome?.();
                    break;
                case 'displaced':
                    reason = message.reason;
                    opts.onDisplaced?.(message.reason);
                    break;
                case 'closed':
                    reason ??= message.reason;
                    break;
                case 'dispatch': {
                    const { correlationId } = message.frame;
                    void opts
                        .run(message.frame)
                        .then((response) =>
                            writeFrame(socket, opts.codec, {
                                type: 'result',
                                correlationId,
                                response,
                            } satisfies InboundGateMessage),
                        )
                        .catch((e: unknown) =>
                            writeFrame(socket, opts.codec, {
                                type: 'result',
                                correlationId,
                                response: {
                                    error: {
                                        code: -32603,
                                        message: `Genie failed while handling this call: ${e instanceof Error ? e.message : String(e)}`,
                                    },
                                },
                            } satisfies InboundGateMessage),
                        );
                    break;
                }
            }
        }
    });

    const finish = () => {
        if (finished) return;
        finished = true;
        opts.onClosed?.(reason ?? 'The connection to the MCP shuttle ended.');
    };
    socket.on('close', finish);
    socket.on('error', (e) => {
        reason ??= e.message;
    });

    return {
        publish(manifest) {
            if (finished) return;
            if (welcomed) sendManifest(manifest);
            else held.manifest = manifest;
        },
        topology(topology) {
            if (finished) return;
            if (welcomed) sendTopology(topology);
            else held.topology = topology;
        },
        close() {
            reason ??= 'Genie closed its connection to the MCP shuttle.';
            socket.destroy();
        },
    };
}
