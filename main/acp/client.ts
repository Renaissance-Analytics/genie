/**
 * JSON-RPC over an ACP agent's stdio.
 *
 * The failure this module exists to prevent is **a promise that never settles.** A
 * request whose response is lost — the child died, the id was mis-correlated, a
 * notification was mistaken for a reply — leaves a caller awaiting forever, and
 * upstream that is indistinguishable from an agent thinking very hard. Genie already
 * knows how that story ends: it is why driving a TUI needed a settle-and-confirm dance
 * and still could only say *"we could not check"*.
 *
 * So every path settles. In order, out of order, on a protocol error, on the child's
 * death, and on a deadline.
 *
 * Transport-agnostic on purpose: it takes a duplex of parsed messages, so the framing
 * (`./ndjson.ts`) and the process (`./spawn.ts`) are both somebody else's problem and
 * every decision here is testable against a fake.
 */

/** A duplex of already-parsed JSON-RPC messages. */
export interface AcpTransport {
    send: (message: unknown) => void;
    onMessage: (cb: (message: unknown) => void) => void;
    /** Called once when the channel is gone, with a reason worth showing a human. */
    onClose: (cb: (reason: string) => void) => void;
}

export interface AcpClientOptions {
    /**
     * How long a single request may go unanswered.
     *
     * Default 60s, matching the handshake budget the protocol's own implementations
     * use. A deadline is not optional here: without one, an agent that accepts a
     * request and never replies is a permanent leak of a caller.
     */
    requestTimeoutMs?: number;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class AcpClient {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
    private readonly requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
    private closedReason: string | null = null;
    private readonly timeoutMs: number;

    constructor(
        private readonly transport: AcpTransport,
        options: AcpClientOptions = {},
    ) {
        this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        transport.onMessage((m) => this.handle(m));
        transport.onClose((reason) => this.close(reason));
    }

    get closed(): boolean {
        return this.closedReason !== null;
    }

    /** Call a method on the agent. */
    request(method: string, params: unknown): Promise<unknown> {
        // Rejecting immediately beats queueing against a channel that will never
        // answer — a caller can retry or report, but it cannot recover from waiting.
        if (this.closedReason !== null) {
            return Promise.reject(new Error(`ACP channel is closed (${this.closedReason}); ${method} not sent`));
        }

        const id = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`ACP request ${method} timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);
            // Never hold the process open on a timer that is only a deadline.
            timer.unref?.();

            this.pending.set(id, { resolve, reject, timer, method });
            this.transport.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    /** Fire-and-forget, for the methods the protocol defines as notifications. */
    notify(method: string, params: unknown): void {
        if (this.closedReason !== null) return;
        this.transport.send({ jsonrpc: '2.0', method, params });
    }

    /** Listen for a notification from the agent (`session/update` and friends). */
    onNotification(method: string, cb: (params: unknown) => void): void {
        const list = this.notificationHandlers.get(method) ?? [];
        list.push(cb);
        this.notificationHandlers.set(method, list);
    }

    /**
     * Serve a request the AGENT makes of us — `session/request_permission`,
     * `elicitation/create`, `fs/*`, `terminal/*`.
     *
     * Every one of these must be answered. An unanswered request parks the agent's
     * turn, so a method with no handler is answered with an ERROR rather than silence:
     * at least that ends the wait and says why.
     */
    onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
        this.requestHandlers.set(method, handler);
    }

    private handle(message: unknown): void {
        if (!message || typeof message !== 'object') return;
        const m = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

        // A request FROM the agent: it has both an id and a method.
        if (typeof m.method === 'string' && m.id !== undefined) {
            void this.serve(m.id as number | string, m.method, m.params);
            return;
        }

        // A notification: a method and NO id. Keeping these apart matters — treating
        // one as a reply would settle the wrong promise with the wrong value.
        if (typeof m.method === 'string') {
            for (const cb of this.notificationHandlers.get(m.method) ?? []) {
                try {
                    cb(m.params);
                } catch {
                    // One bad listener must not stop the next message arriving. The
                    // agent is still running and its turn is still going.
                }
            }
            return;
        }

        // A response.
        if (typeof m.id === 'number') {
            const pending = this.pending.get(m.id);
            // A response for an id we never sent is a confused or hostile child.
            // Ignored, not thrown — throwing here would take the connection down.
            if (!pending) return;
            this.pending.delete(m.id);
            clearTimeout(pending.timer);

            if (m.error) {
                const err = m.error as { message?: string; code?: number };
                pending.reject(
                    new Error(`ACP ${pending.method} failed: ${err.message ?? 'unknown error'} (${err.code ?? '?'})`),
                );
            } else {
                pending.resolve(m.result);
            }
        }
    }

    private async serve(id: number | string, method: string, params: unknown): Promise<void> {
        const handler = this.requestHandlers.get(method);
        if (!handler) {
            this.transport.send({
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `Genie does not serve ${method}` },
            });
            return;
        }
        try {
            this.transport.send({ jsonrpc: '2.0', id, result: await handler(params) });
        } catch (err) {
            // The agent is waiting on this. An error reply ends its wait; a swallowed
            // exception would park it until the deadline on its side, if it has one.
            this.transport.send({
                jsonrpc: '2.0',
                id,
                error: { code: -32603, message: (err as Error).message },
            });
        }
    }

    /** Called on the child's death, and whatever else loses the channel. */
    close(reason: string): void {
        if (this.closedReason !== null) return;
        this.closedReason = reason;
        // Reject EVERY request in flight. This is the whole point of the module.
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(new Error(`ACP channel closed before ${pending.method} answered: ${reason}`));
        }
    }
}
