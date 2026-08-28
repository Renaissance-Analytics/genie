import { describe, expect, it } from 'vitest';
import { CodexAgentInboxSession, type CodexAppServerSocket } from '../codex-app-server';

class FakeSocket implements CodexAppServerSocket {
    sent: Array<Record<string, unknown>> = [];
    private listener: ((data: string) => void) | null = null;
    private closeListener: ((error?: Error) => void) | null = null;

    constructor(public respond = true) {}

    send(data: string): void {
        const message = JSON.parse(data) as Record<string, unknown>;
        this.sent.push(message);
        const id = message.id as number | undefined;
        if (id === undefined || !this.respond) return;
        const method = message.method;
        const result = method === 'initialize'
            ? { userAgent: 'test' }
            : method === 'thread/start'
              ? { thread: { id: 'thread-1' } }
              : method === 'thread/resume'
                ? { thread: { id: 'saved-thread' } }
              : {};
        queueMicrotask(() => this.emit({ jsonrpc: '2.0', id, result }));
    }

    onMessage(listener: (data: string) => void): void {
        this.listener = listener;
    }

    onClose(listener: (error?: Error) => void): void {
        this.closeListener = listener;
    }

    close(error?: Error): void {
        this.closeListener?.(error);
    }

    emit(message: Record<string, unknown>): void {
        this.listener?.(JSON.stringify(message));
    }
}

describe('Codex App Server AgentInbox adapter', () => {
    it('initializes one durable thread before accepting messages', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);

        await session.initialize('C:/workspace');

        expect(socket.sent.map((message) => message.method)).toEqual([
            'initialize',
            'notifications/initialized',
            'thread/start',
        ]);
        expect(session.threadId).toBe('thread-1');
        expect(session.isIdle).toBe(true);
    });

    it('resumes a saved Codex thread instead of starting a replacement', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);

        await session.initialize('C:/workspace', 'saved-thread');

        expect(socket.sent.map((message) => message.method)).toEqual([
            'initialize',
            'notifications/initialized',
            'thread/resume',
        ]);
        expect(socket.sent.at(-1)).toMatchObject({
            params: { threadId: 'saved-thread', cwd: 'C:/workspace' },
        });
    });

    it('starts an idle turn through App Server and never steers or writes a terminal', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('C:/workspace');

        await session.deliver({ text: 'review the inbox message' });

        const methods = socket.sent.map((message) => message.method);
        expect(methods).toContain('turn/start');
        expect(methods).not.toContain('turn/steer');
        expect(JSON.stringify(socket.sent)).not.toMatch(/pty|terminal|keystroke/i);
        expect(socket.sent.at(-1)).toMatchObject({
            method: 'turn/start',
            params: {
                threadId: 'thread-1',
                input: [{ type: 'text', text: 'review the inbox message' }],
            },
        });
    });

    it('does not accept a queued message until turn/start succeeds', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('C:/workspace');
        socket.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1' } });

        let accepted = false;
        const delivery = session.deliver({ text: 'wait for idle' }).then(() => { accepted = true; });
        await Promise.resolve();
        expect(accepted).toBe(false);
        expect(socket.sent.filter((message) => message.method === 'turn/start')).toHaveLength(0);

        socket.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1' } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await delivery;

        expect(socket.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
        expect(socket.sent.at(-1)).toMatchObject({
            params: { input: [{ text: 'wait for idle' }] },
        });
    });

    it('rejects overflow instead of growing the busy queue without bound', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket, {
            maxQueuedMessages: 1,
            maxQueuedBytes: 32,
        });
        await session.initialize('C:/workspace');
        socket.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1' } });

        void session.deliver({ text: 'first' });
        await expect(session.deliver({ text: 'second' })).rejects.toThrow(/capacity/i);
    });

    it('bounds the busy queue by serialized bytes as well as message count', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket, {
            maxQueuedMessages: 10,
            maxQueuedBytes: 8,
        });
        await session.initialize('C:/workspace');
        socket.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1' } });

        await expect(session.deliver({ text: 'larger than eight bytes' })).rejects.toThrow(/capacity/i);
    });

    it('times out an App Server request that never answers', async () => {
        const session = new CodexAgentInboxSession(new FakeSocket(false), { requestTimeoutMs: 5 });
        await expect(session.initialize('C:/workspace')).rejects.toThrow(/timed out/i);
    });

    it('rejects pending requests and queued deliveries when the socket closes', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('C:/workspace');
        socket.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1' } });
        const delivery = session.deliver({ text: 'still durable' });

        socket.close(new Error('socket gone'));

        await expect(delivery).rejects.toThrow('socket gone');
    });

    it('rejects an in-flight JSON-RPC request immediately when the socket closes', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket, { requestTimeoutMs: 50 });
        await session.initialize('C:/workspace');
        socket.respond = false;
        const delivery = session.deliver({ text: 'request is pending' });

        socket.close(new Error('socket gone'));

        await expect(delivery).rejects.toThrow('socket gone');
    });

    it('deduplicates the durable backlog against simultaneous live delivery', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('C:/workspace');

        await session.deliver({ text: 'once', messageId: 'message-1' });
        await session.deliver({ text: 'once', messageId: 'message-1' });
        socket.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1' } });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(socket.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    });
});
