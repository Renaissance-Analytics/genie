import { describe, expect, it, vi } from 'vitest';
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

describe('a request from the SERVER cannot wedge the thread', () => {
    /**
     * Measured by prism against a live Codex App Server on CLI 0.160.0, while speccing an ACP
     * driver, and it lands on code Genie already ships:
     *
     *  - codex asks for command approval as a **server-to-client request** —
     *    `item/commandExecution/requestApproval`, carrying an `id`, answered with
     *    `{ result: { decision } }`;
     *  - **nothing times it out.** At ~47 seconds unanswered the thread still held an active
     *    writer and emitted no expiry frame. An unanswered request HANGS rather than failing safe.
     *
     * This adapter answered responses by numeric id and two notifications, and ignored requests
     * entirely. So an approval it never answered means `turn/completed` never arrives, `busy`
     * stays true for the life of the session, and every later DM to that agent queues until the
     * cap rejects it — which reads to the owner as "my agent stopped getting mail", nowhere near
     * the cause.
     *
     * ## Why `cancel` rather than `accept`
     *
     * This socket is a MAIL DELIVERY boundary. Approving a command on a human's behalf because a
     * message arrived is not a thing a mail channel may do, and the agent's own surface is where a
     * person says yes. Declining is the fail-safe answer and `turn/completed` `interrupted`
     * follows it, so the queue drains instead of stalling.
     */
    const approvalRequest = (id: number) => ({
        jsonrpc: '2.0',
        id,
        method: 'item/commandExecution/requestApproval',
        params: {
            threadId: 'thread-1',
            availableDecisions: ['accept', 'cancel', 'acceptWithExecpolicyAmendment'],
        },
    });

    it('ANSWERS an approval request instead of leaving it open', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('/repo');
        socket.sent.length = 0;

        socket.emit(approvalRequest(77));

        await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
        const reply = socket.sent[0]!;
        // Answered by the SAME id, or it answers nothing: a reply under a fresh id is a new
        // request as far as the server is concerned, and the original still hangs.
        expect(reply.id).toBe(77);
        expect(reply.result).toEqual({ decision: 'cancel' });
        // And it is a RESULT, not an error — an error answer is also an answer, but codex reads a
        // decision and `cancel` is the one that says "the human did not approve this".
        expect(reply.error).toBeUndefined();
    });

    it('leaves the queue DRAINABLE, which is the whole point', async () => {
        // The symptom this prevents. A turn that never completes holds `busy` forever, and the
        // next message waits behind an approval nobody is ever going to answer.
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('/repo');
        socket.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1' } });

        const queued = session.deliver({ text: 'mail while busy' });
        socket.emit(approvalRequest(78));
        // Declining ends the TURN — prism measured `item/completed` `declined` then
        // `turn/completed` `interrupted` — which is what releases the queue.
        socket.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1' } });

        await expect(queued).resolves.toBeUndefined();
    });

    it('answers an unrecognised server request too, rather than only approvals', async () => {
        // The failure mode is "a request with an id went unanswered", not "an approval did". A
        // method this adapter has never heard of must not be the thing that wedges a thread, and
        // a server that adds one should not need a Genie release to stay unwedged.
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('/repo');
        socket.sent.length = 0;

        socket.emit({ jsonrpc: '2.0', id: 91, method: 'some/futureRequest', params: {} });

        await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
        const reply = socket.sent[0]!;
        expect(reply.id).toBe(91);
        // An ERROR here, not a decision: inventing a `decision` for a method we do not know would
        // be answering a question we did not read.
        expect(reply.error).toMatchObject({ code: -32601 });
    });

    it('does not answer a NOTIFICATION, which has nothing to answer', async () => {
        // `turn/started` has no id. Replying to one would put a response on the wire that the
        // server never asked for.
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('/repo');
        socket.sent.length = 0;

        socket.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1' } });
        socket.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1' } });

        await new Promise((r) => setTimeout(r, 10));
        expect(socket.sent).toEqual([]);
    });
});

describe('thread/resume does not ask for history it never reads', () => {
    /**
     * prism, from the same probe: **full-history hydration on `thread/resume` is deprecated.** The
     * server emitted a `deprecationNotice` pointing at `excludeTurns: true` plus
     * `thread/turns/list` / `thread/items/list`.
     *
     * This adapter reads exactly one field off the response — `result.thread.id` — so the history
     * was being built, serialised and thrown away on every resume. Asking for it excluded is
     * cheaper, and it takes Genie off a deprecation that is already on the clock.
     */
    it('resumes with excludeTurns, because only the thread id is used', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('/repo', 'saved-thread');

        const resume = socket.sent.find((m) => m.method === 'thread/resume');
        expect(resume?.params).toEqual({
            threadId: 'saved-thread',
            cwd: '/repo',
            excludeTurns: true,
        });
        // POSITIVE CONTROL: the id still comes back and is still what the session runs on.
        expect(session.threadId).toBe('saved-thread');
    });

    it('does not send excludeTurns on a FRESH thread, which has no turns to exclude', async () => {
        const socket = new FakeSocket();
        const session = new CodexAgentInboxSession(socket);
        await session.initialize('/repo');
        const start = socket.sent.find((m) => m.method === 'thread/start');
        expect(start?.params).toEqual({ cwd: '/repo' });
    });
});
