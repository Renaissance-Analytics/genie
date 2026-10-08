import type { HarnessTransportPayload } from './harness-transport';

export interface CodexAppServerSocket {
    send(data: string): void;
    onMessage(listener: (data: string) => void): void;
    onClose(listener: (error?: Error) => void): void;
}

interface RpcResponse {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { message?: string };
}

interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

interface QueuedDelivery {
    payload: HarnessTransportPayload;
    bytes: number;
    resolve(): void;
    reject(error: Error): void;
}

/** The redacted shape of an overage rate-limit frame. Numbers and enums, nothing that names anyone. */
export interface CodexRateLimitSample {
    windows: Array<{ name: string; usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }>;
    planType: string | null;
    spendControlReached: boolean;
    rateLimitReachedType: string | null;
    /** Whether `credits` was in the payload. Its VALUE is deliberately not carried. */
    creditsPresent: boolean;
}

export interface CodexAgentInboxSessionOptions {
    requestTimeoutMs?: number;
    maxQueuedMessages?: number;
    maxQueuedBytes?: number;
    /**
     * CAPTURE AN OVERAGE RATE-LIMIT FRAME — once, redacted, and only when it is interesting.
     *
     * Asked for by prism while deciding whether a codex reading may exceed 100%. Their claude parser
     * accepts over-allowance because the provider models it; their codex parser refused it, and a
     * refusal is total — one bad field rejects the payload and the gauge disappears. Neither of us
     * has ever captured an overage frame, so the bound was a guess either way, except that **an
     * empty gauge reads as plenty of headroom**, which makes the two guesses cost different
     * amounts. They removed the bound on that argument and recorded the question as undetermined.
     *
     * This is Genie's half: if it ever happens here, keep the shape.
     *
     * Absent means the frame is dropped, exactly as every other unhandled notification is — which
     * is what it did before this existed.
     */
    onRateLimitSample?: (sample: CodexRateLimitSample) => void;
}

/**
 * Harness adapter for AgentInbox → Codex App Server.
 *
 * The App Server thread is the delivery boundary. Messages arriving mid-turn
 * remain in this bounded in-memory dispatch queue (and in AgentInbox's durable
 * store) until `turn/completed`; they are never injected into the visible TUI
 * and never sent with `turn/steer`.
 */
export class CodexAgentInboxSession {
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private queue: QueuedDelivery[] = [];
    private queuedBytes = 0;
    private deliveredMessageIds = new Set<string>();
    private inFlightMessageIds = new Map<string, Promise<void>>();
    private busy = true;
    private currentThreadId: string | null = null;

    /** ONCE. A notification that repeats every turn would fill the log with the same sample and
     *  teach the owner to skip the line that matters. */
    private rateLimitSampled = false;
    private readonly onRateLimitSample: CodexAgentInboxSessionOptions['onRateLimitSample'];

    private readonly requestTimeoutMs: number;
    private readonly maxQueuedMessages: number;
    private readonly maxQueuedBytes: number;

    constructor(
        private readonly socket: CodexAppServerSocket,
        options: CodexAgentInboxSessionOptions = {},
    ) {
        this.onRateLimitSample = options.onRateLimitSample;
        this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 10_000);
        this.maxQueuedMessages = Math.max(1, options.maxQueuedMessages ?? 100);
        this.maxQueuedBytes = Math.max(1, options.maxQueuedBytes ?? 1024 * 1024);
        socket.onMessage((data) => this.handleMessage(data));
        socket.onClose((error) => this.close(error ?? new Error('Codex App Server connection closed.')));
    }

    get threadId(): string | null {
        return this.currentThreadId;
    }

    get isIdle(): boolean {
        return !!this.currentThreadId && !this.busy;
    }

    async initialize(cwd: string, resumeThreadId?: string | null): Promise<void> {
        await this.request('initialize', {
            clientInfo: { name: 'genie-agentinbox', version: '1' },
            capabilities: {},
        });
        this.notify('notifications/initialized', {});
        const result = await this.request(
            resumeThreadId ? 'thread/resume' : 'thread/start',
            resumeThreadId
                // `excludeTurns`: this session reads exactly one field off the answer — the thread
                // id — so the full history was being built, serialised and thrown away on every
                // resume. prism measured the server emitting a `deprecationNotice` for the
                // hydrated form, pointing at this flag plus `thread/turns/list` /
                // `thread/items/list`, so excluding it is both cheaper and the direction the
                // server is going.
                ? { threadId: resumeThreadId, cwd, excludeTurns: true }
                : { cwd },
        ) as {
            thread?: { id?: string };
        };
        const id = result.thread?.id;
        if (!id) throw new Error('Codex App Server did not return a thread id.');
        this.currentThreadId = id;
        this.busy = false;
    }

    async deliver(payload: HarnessTransportPayload): Promise<void> {
        if (!this.currentThreadId) throw new Error('Codex App Server session is not initialized.');
        const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
        if (messageId && this.deliveredMessageIds.has(messageId)) return;
        if (messageId && this.inFlightMessageIds.has(messageId)) {
            return this.inFlightMessageIds.get(messageId)!;
        }
        const delivery = this.accept(payload);
        if (messageId) this.inFlightMessageIds.set(messageId, delivery);
        try {
            await delivery;
            if (!messageId) return;
            this.deliveredMessageIds.add(messageId);
            if (this.deliveredMessageIds.size > 1_000) {
                const oldest = this.deliveredMessageIds.values().next().value as string | undefined;
                if (oldest) this.deliveredMessageIds.delete(oldest);
            }
        } finally {
            if (messageId) this.inFlightMessageIds.delete(messageId);
        }
    }

    private accept(payload: HarnessTransportPayload): Promise<void> {
        if (this.busy) {
            const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
            if (this.queue.length >= this.maxQueuedMessages || this.queuedBytes + bytes > this.maxQueuedBytes) {
                return Promise.reject(new Error('Codex App Server delivery queue is at capacity.'));
            }
            return new Promise<void>((resolve, reject) => {
                this.queue.push({ payload, bytes, resolve, reject });
                this.queuedBytes += bytes;
            });
        }
        return this.startTurn(payload);
    }

    private async startTurn(payload: HarnessTransportPayload): Promise<void> {
        if (!this.currentThreadId) return;
        this.busy = true;
        try {
            await this.request('turn/start', {
                threadId: this.currentThreadId,
                input: [{ type: 'text', text: payload.text }],
            });
        } catch (error) {
            this.busy = false;
            throw error;
        }
    }

    private flushOne(): void {
        if (this.busy) return;
        const next = this.queue.shift();
        if (!next) return;
        this.queuedBytes -= next.bytes;
        void this.startTurn(next.payload).then(next.resolve, next.reject);
    }

    private handleMessage(data: string): void {
        let message: RpcResponse;
        try {
            message = JSON.parse(data) as RpcResponse;
        } catch {
            return;
        }
        /**
         * A REQUEST FROM THE SERVER — answer it, always.
         *
         * Codex asks for command approval this way (`item/commandExecution/requestApproval`, an
         * `id` and a `method` together), and prism measured that **nothing times it out**: at ~47
         * seconds unanswered the thread still held an active writer and emitted no expiry frame.
         * An unanswered request HANGS rather than failing safe — and this adapter used to ignore
         * requests entirely, so `turn/completed` never arrived, `busy` stayed true for the life of
         * the session, and every later DM queued until the cap rejected it. The owner would read
         * that as "my agent stopped getting mail", nowhere near the cause.
         *
         * An approval is DECLINED. This socket is a mail-delivery boundary: approving a command on
         * a human's behalf because a message arrived is not a thing it may do, and the agent's own
         * surface is where a person says yes. Declining ends the turn (prism recorded
         * `item/completed` `declined` then `turn/completed` `interrupted`), which releases the
         * queue instead of stalling it.
         *
         * Anything else gets `-32601`. The failure mode is "a request with an id went unanswered",
         * not "an approval did" — so a method this adapter has never heard of must not be the thing
         * that wedges a thread, and a server that adds one should not need a Genie release to stay
         * unwedged. An error rather than an invented `decision`, because answering a question we
         * did not read is how the wrong command gets approved.
         */
        if (typeof message.id === 'number' && typeof message.method === 'string') {
            const isApproval = message.method.endsWith('requestApproval');
            this.socket.send(
                JSON.stringify(
                    isApproval
                        ? { jsonrpc: '2.0', id: message.id, result: { decision: 'cancel' } }
                        : {
                              jsonrpc: '2.0',
                              id: message.id,
                              error: {
                                  code: -32601,
                                  message: `genie-agentinbox does not serve ${message.method}`,
                              },
                          },
                ),
            );
            return;
        }

        if (typeof message.id === 'number') {
            // A RESPONSE to something we sent. Reached only after the request branch above, which
            // is the ordering that matters: a server REQUEST also carries a numeric id, so this
            // lookup found no pending entry and returned — swallowing it.
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            clearTimeout(request.timer);
            if (message.error) {
                request.reject(new Error(message.error.message || 'Codex App Server request failed.'));
            } else {
                request.resolve(message.result);
            }
            return;
        }
        if (message.method === 'account/rateLimits/updated') {
            this.maybeSampleRateLimit(message.params);
            return;
        }

        if (message.method === 'turn/started') {
            this.busy = true;
        } else if (message.method === 'turn/completed') {
            this.busy = false;
            this.flushOne();
        }
    }

    /**
     * Is this frame worth keeping, and if so what survives redaction?
     *
     * The gate is prism's: `usedPercent >= 90`, or `spendControlReached`, or `rateLimitReachedType`
     * set. The last two matter because codex may express overage in THOSE rather than in a figure
     * above 100 — which is the open question this capture exists to answer.
     *
     * Redaction is allow-list, not deny-list: the sample is BUILT from the fields prism named rather
     * than copied and pruned. A deny-list forwards whatever a future field is called.
     */
    private maybeSampleRateLimit(params: unknown): void {
        const sink = this.onRateLimitSample;
        if (!sink || this.rateLimitSampled) return;
        if (typeof params !== 'object' || params === null) return;

        const p = params as Record<string, unknown>;
        const limits = (p.rateLimits ?? {}) as Record<string, unknown>;
        const windows = Object.entries(limits)
            .filter(([, w]) => typeof w === 'object' && w !== null)
            .map(([name, w]) => {
                const win = w as Record<string, unknown>;
                return {
                    name,
                    usedPercent: typeof win.usedPercent === 'number' ? win.usedPercent : -1,
                    windowDurationMins:
                        typeof win.windowDurationMins === 'number' ? win.windowDurationMins : null,
                    resetsAt: typeof win.resetsAt === 'number' ? win.resetsAt : null,
                };
            });

        const spendControlReached = p.spendControlReached === true;
        const rateLimitReachedType =
            typeof p.rateLimitReachedType === 'string' ? p.rateLimitReachedType : null;
        const interesting =
            spendControlReached
            || rateLimitReachedType !== null
            || windows.some((w) => w.usedPercent >= 90);
        if (!interesting) return;

        this.rateLimitSampled = true;
        try {
            sink({
                windows,
                planType: typeof p.planType === 'string' ? p.planType : null,
                spendControlReached,
                rateLimitReachedType,
                // The PRESENCE of credits, never the balance.
                creditsPresent: p.credits !== undefined && p.credits !== null,
            });
        } catch {
            // A capture must never take a delivery down with it. A lost sample is a gap in an
            // answer; a throw inside a notification handler kills the subscription.
        }
    }

    private request(method: string, params: Record<string, unknown>): Promise<unknown> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Codex App Server request ${method} timed out.`));
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private close(error: Error): void {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        for (const queued of this.queue.splice(0)) queued.reject(error);
        this.queuedBytes = 0;
        this.busy = true;
    }

    private notify(method: string, params: Record<string, unknown>): void {
        this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    }
}
