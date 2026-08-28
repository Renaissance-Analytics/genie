import type { HarnessTransportPayload } from './harness-transport';

export interface CodexAppServerSocket {
    send(data: string): void;
    onMessage(listener: (data: string) => void): void;
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
    private queue: HarnessTransportPayload[] = [];
    private deliveredMessageIds = new Set<string>();
    private busy = true;
    private currentThreadId: string | null = null;

    constructor(private readonly socket: CodexAppServerSocket) {
        socket.onMessage((data) => this.handleMessage(data));
    }

    get threadId(): string | null {
        return this.currentThreadId;
    }

    get isIdle(): boolean {
        return !!this.currentThreadId && !this.busy;
    }

    async initialize(cwd: string): Promise<void> {
        await this.request('initialize', {
            clientInfo: { name: 'genie-agentinbox', version: '1' },
            capabilities: {},
        });
        this.notify('notifications/initialized', {});
        const result = await this.request('thread/start', { cwd }) as {
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
        if (messageId) {
            this.deliveredMessageIds.add(messageId);
            if (this.deliveredMessageIds.size > 1_000) {
                const oldest = this.deliveredMessageIds.values().next().value as string | undefined;
                if (oldest) this.deliveredMessageIds.delete(oldest);
            }
        }
        if (this.busy) {
            this.queue.push(payload);
            return;
        }
        await this.startTurn(payload);
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
        void this.startTurn(next).catch(() => {
            this.queue.unshift(next);
        });
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
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        });
    }

    private notify(method: string, params: Record<string, unknown>): void {
        this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    }
}
