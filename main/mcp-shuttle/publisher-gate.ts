import { timingSafeEqual } from 'node:crypto';
import type { DispatchFrame, Publisher, ShuttleCore, ShuttleResponse } from './core';
import type { ShuttleManifest } from './manifest-store';
import type { ShuttleTopology } from './topology-store';

/**
 * WHO MAY PUBLISH — the MCP shuttle's control-channel gate.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §4.1.
 *
 * The shuttle forwards every tool call an agent makes to the attached PUBLISHER and
 * serves the surface that publisher declared, so the publisher defines what every
 * agent on this machine can call. In the spec's words: "This is load-bearing
 * security, not hygiene. A shuttle that accepted any local publisher would let any
 * process on the box redefine every tool every agent in Genie can call."
 *
 * ## The rules
 *
 * 1. **Authenticate first, act never before.** The first message a connection
 *    sends must be a `hello` carrying the secret from `publisher.secret`. Anything
 *    else first, or a wrong secret, closes the connection. It cannot act and
 *    authenticate later.
 * 2. **Exactly one publisher.** A second AUTHENTICATED connection takes over: the
 *    new Genie is the live one and the old is being replaced. The displaced
 *    connection is told so and closed.
 * 3. **An incompatible wire generation is refused by name** — it is the Phase 0
 *    deep-upgrade condition, and a silent refusal would read as a hung Genie.
 * 4. **Only the publisher's own frames count.** A result from any other
 *    connection is dropped, or a displaced socket could answer a call the live
 *    Genie is still running.
 * 5. **Only the publisher's own close detaches.** A late close from a connection
 *    that was already displaced must not detach the NEW Genie that replaced it.
 * 6. **Only the publisher defines the surface and the routes.** A `publish`
 *    (the manifest every agent is served) or a `topology` (where each URL leads)
 *    counts only from the live publisher — never from a displaced Genie, and an
 *    unauthenticated connection is refused before it can send one.
 *
 * Framing is not this file's job — it takes decoded messages. The wire itself is
 * `fancy-term-host`'s length-prefixed framing, which the spec asks the shuttle to
 * reuse because it is already proven cross-platform.
 */

/** A control-channel connection, as the gate sees it. */
export interface GateConnection {
    send(message: GateMessage): void;
    close(reason: string): void;
}

export type GateMessage =
    | { type: 'hello'; wireGeneration: number; secret: string; generation: number }
    | { type: 'welcome'; wireGeneration: number }
    | { type: 'displaced'; reason: string }
    | { type: 'dispatch'; frame: DispatchFrame }
    | { type: 'result'; correlationId: number; response: ShuttleResponse }
    | { type: 'publish'; manifest: ShuttleManifest }
    | { type: 'topology'; topology: ShuttleTopology };

export interface PublisherGateOptions {
    secret: string;
    wireGeneration: number;
    core: ShuttleCore;
    /** The live publisher published its surface. */
    onPublish?: (manifest: ShuttleManifest) => void;
    /** The live publisher published its routing topology. */
    onTopology?: (topology: ShuttleTopology) => void;
}

export interface PublisherGate {
    connected(conn: GateConnection): void;
    message(conn: GateConnection, message: GateMessage): void;
    closed(conn: GateConnection): void;
    /** The connection currently attached as publisher, or null. */
    publisher(): GateConnection | null;
}

/**
 * Compare two secrets in constant time, and REFUSE rather than throw on a length
 * mismatch.
 *
 * `timingSafeEqual` throws when the buffers differ in length. On this path that
 * throw would unwind the shuttle's control loop, so anyone able to open the pipe
 * could take the shuttle down by sending a one-character secret. Comparing the
 * lengths first leaks only the length, which a fixed-length generated secret does
 * not make secret anyway.
 */
function secretMatches(presented: unknown, expected: string): boolean {
    if (typeof presented !== 'string') return false;
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/**
 * How a wire-generation refusal begins. Genie's supervisor matches on it: of all
 * the reasons a shuttle can refuse a publisher, this is the only one that means
 * "an older shuttle of ours is running, replace it". Every shuttle that has ever
 * shipped words it this way, which is what makes it safe to match on.
 */
export const WIRE_MISMATCH_PREFIX = 'Wire generation mismatch:';

export function createPublisherGate(opts: PublisherGateOptions): PublisherGate {
    const { core, wireGeneration } = opts;
    /** Connections that have presented a valid hello. Only these may ever publish. */
    const authenticated = new Set<GateConnection>();
    let current: GateConnection | null = null;

    const refuse = (conn: GateConnection, reason: string): void => {
        authenticated.delete(conn);
        conn.close(reason);
    };

    /** The core's view of a publisher: dispatching is a frame on its connection. */
    const asPublisher = (conn: GateConnection): Publisher => ({
        dispatch: (frame) => conn.send({ type: 'dispatch', frame }),
    });

    return {
        connected() {
            // Nothing is granted on connect. A connection is inert until a valid
            // hello — which is exactly what stops "connecting" from meaning
            // "evicting the real Genie".
        },

        message(conn, message) {
            if (!authenticated.has(conn)) {
                if (message.type !== 'hello') {
                    refuse(conn, 'The first message on the shuttle control channel must be hello.');
                    return;
                }
                if (message.wireGeneration !== wireGeneration) {
                    refuse(
                        conn,
                        `${WIRE_MISMATCH_PREFIX} this shuttle speaks ${wireGeneration}, the publisher ` +
                            `speaks ${message.wireGeneration}. That is a deep upgrade; the shuttle must be ` +
                            'replaced alongside Genie.',
                    );
                    return;
                }
                if (!secretMatches(message.secret, opts.secret)) {
                    refuse(conn, 'Publisher authentication failed.');
                    return;
                }

                authenticated.add(conn);
                const previous = current;
                current = conn;
                if (previous && previous !== conn) {
                    // Take over. Detach FIRST so the core answers the old Genie's
                    // in-flight calls as interrupted, then attach the new one.
                    authenticated.delete(previous);
                    core.detach();
                    previous.send({
                        type: 'displaced',
                        reason: 'A newer Genie authenticated and took over as publisher.',
                    });
                    previous.close('displaced');
                }
                conn.send({ type: 'welcome', wireGeneration });
                core.attach(asPublisher(conn), message.generation);
                return;
            }

            // Everything below speaks for the live publisher, so nothing else may.
            if (conn !== current) return;
            if (message.type === 'result') {
                core.result(message.correlationId, message.response);
            } else if (message.type === 'publish') {
                opts.onPublish?.(message.manifest);
            } else if (message.type === 'topology') {
                opts.onTopology?.(message.topology);
            }
        },

        closed(conn) {
            authenticated.delete(conn);
            // A close from anything but the live publisher changes nothing — in
            // particular a late close from a displaced Genie must not detach the
            // new one that replaced it.
            if (conn !== current) return;
            current = null;
            core.detach();
        },

        publisher() {
            return current;
        },
    };
}
