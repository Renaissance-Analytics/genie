import { describe, expect, it } from 'vitest';
import { CodexAgentInboxSession, type CodexAppServerSocket } from '../codex-app-server';

class FakeSocket implements CodexAppServerSocket {
    sent: Array<Record<string, unknown>> = [];
    private listener: ((data: string) => void) | null = null;

    send(data: string): void {
        const message = JSON.parse(data) as Record<string, unknown>;
        this.sent.push(message);
        const id = message.id as number | undefined;
        if (id === undefined) return;
        const method = message.method;
        const result = method === 'initialize'
            ? { userAgent: 'test' }
            : method === 'thread/start'
              ? { thread: { id: 'thread-1' } }
              : {};
        queueMicrotask(() => this.emit({ jsonrpc: '2.0', id, result }));
    }

    onMessage(listener: (data: string) => void): void {
        this.listener = listener;
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

    it('queues while busy and dispatches after turn/completed', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('C:/workspace');
        socket.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1' } });

        await session.deliver({ text: 'wait for idle' });
        expect(socket.sent.filter((message) => message.method === 'turn/start')).toHaveLength(0);

        socket.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1' } });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(socket.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
        expect(socket.sent.at(-1)).toMatchObject({
            params: { input: [{ text: 'wait for idle' }] },
        });
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
