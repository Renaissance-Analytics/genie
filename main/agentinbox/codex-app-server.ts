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

export interface CodexAgentInboxSessionOptions {
    requestTimeoutMs?: number;
    maxQueuedMessages?: number;
    maxQueuedBytes?: number;
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

    private readonly requestTimeoutMs: number;
    private readonly maxQueuedMessages: number;
    private readonly maxQueuedBytes: number;

    constructor(
        private readonly socket: CodexAppServerSocket,
        options: CodexAgentInboxSessionOptions = {},
    ) {
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
            resumeThreadId ? { threadId: resumeThreadId, cwd } : { cwd },
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
        if (typeof message.id === 'number') {
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
        if (message.method === 'turn/started') {
            this.busy = true;
        } else if (message.method === 'turn/completed') {
            this.busy = false;
            this.flushOne();
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
