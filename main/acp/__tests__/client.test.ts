import { describe, expect, it, vi } from 'vitest';
import { AcpClient, type AcpTransport } from '../client';

/**
 * JSON-RPC over the agent's stdio.
 *
 * The failure this module exists to prevent is **a promise that never settles.** A
 * request whose response is lost — because the child died, because the id was
 * mis-correlated, because a notification was mistaken for a reply — leaves a caller
 * awaiting forever. Upstream that looks like an agent thinking very hard, and nothing
 * in Genie can tell the difference, which is the whole reason the pty had a
 * settle-and-confirm dance.
 *
 * So every test here is about settling: in order, out of order, on error, on death,
 * and on deadline.
 */

const fake = () => {
    const sent: unknown[] = [];
    let onMessage: ((v: unknown) => void) | null = null;
    let onClose: ((reason: string) => void) | null = null;
    const transport: AcpTransport = {
        send: (v) => sent.push(v),
        onMessage: (cb) => {
            onMessage = cb;
        },
        onClose: (cb) => {
            onClose = cb;
        },
    };
    return {
        transport,
        sent,
        deliver: (v: unknown) => onMessage?.(v),
        die: (reason: string) => onClose?.(reason),
    };
};

describe('requests', () => {
    it('sends a JSON-RPC request and resolves with its result', async () => {
        const f = fake();
        const c = new AcpClient(f.transport);
        const p = c.request('initialize', { protocolVersion: 1 });

        expect(f.sent).toHaveLength(1);
        const req = f.sent[0] as { id: number; method: string; params: unknown; jsonrpc: string };
        expect(req.jsonrpc).toBe('2.0');
        expect(req.method).toBe('initialize');
        expect(req.params).toEqual({ protocolVersion: 1 });

        f.deliver({ jsonrpc: '2.0', id: req.id, result: { ok: true } });
        await expect(p).resolves.toEqual({ ok: true });
    });

    it('correlates responses that arrive OUT OF ORDER', async () => {
        // Two in flight, answered backwards. Resolving by arrival order instead of by
        // id would hand each caller the other's answer — and both would look like
        // successes.
        const f = fake();
        const c = new AcpClient(f.transport);
        const a = c.request('a', {});
        const b = c.request('b', {});
        const [reqA, reqB] = f.sent as Array<{ id: number }>;

        f.deliver({ jsonrpc: '2.0', id: reqB!.id, result: 'B' });
        f.deliver({ jsonrpc: '2.0', id: reqA!.id, result: 'A' });

        await expect(a).resolves.toBe('A');
        await expect(b).resolves.toBe('B');
    });

    it('rejects on a JSON-RPC error rather than resolving with it', async () => {
        const f = fake();
        const c = new AcpClient(f.transport);
        const p = c.request('session/new', {});
        const id = (f.sent[0] as { id: number }).id;

        f.deliver({ jsonrpc: '2.0', id, error: { code: -32000, message: 'auth required' } });
        await expect(p).rejects.toThrow(/auth required/);
    });

    it('does not resolve a request from a NOTIFICATION that happens to look similar', async () => {
        // A notification has no id. Treating one as a reply would settle the wrong
        // promise with the wrong value.
        const f = fake();
        const c = new AcpClient(f.transport);
        const p = c.request('a', {});
        let settled = false;
        void p.then(() => {
            settled = true;
        });

        f.deliver({ jsonrpc: '2.0', method: 'session/update', params: { sessionUpdate: 'notice' } });
        await Promise.resolve();
        expect(settled).toBe(false);

        f.deliver({ jsonrpc: '2.0', id: (f.sent[0] as { id: number }).id, result: 'ok' });
        await expect(p).resolves.toBe('ok');
    });

    it('ignores a response for an id it never sent', async () => {
        // A confused or hostile child. It must not throw out of the message handler and
        // take the connection down.
        const f = fake();
        const c = new AcpClient(f.transport);
        expect(() => f.deliver({ jsonrpc: '2.0', id: 9999, result: 'ghost' })).not.toThrow();
    });
});

describe('when the child dies', () => {
    it('REJECTS every request in flight instead of leaving them hanging', async () => {
        // The failure this module exists for. A hung promise upstream is
        // indistinguishable from an agent thinking hard.
        const f = fake();
        const c = new AcpClient(f.transport);
        const a = c.request('a', {});
        const b = c.request('b', {});

        f.die('exited with code 1');

        await expect(a).rejects.toThrow(/exited with code 1/);
        await expect(b).rejects.toThrow(/exited with code 1/);
    });

    it('rejects a request made AFTER it died, rather than queueing it forever', async () => {
        const f = fake();
        const c = new AcpClient(f.transport);
        f.die('gone');
        await expect(c.request('a', {})).rejects.toThrow(/gone/);
    });

    it('reports closed, so a caller can stop asking', () => {
        const f = fake();
        const c = new AcpClient(f.transport);
        expect(c.closed).toBe(false);
        f.die('gone');
        expect(c.closed).toBe(true);
    });
});

describe('deadlines', () => {
    it('rejects a request that is never answered', async () => {
        vi.useFakeTimers();
        try {
            const f = fake();
            const c = new AcpClient(f.transport, { requestTimeoutMs: 1_000 });
            const p = c.request('initialize', {});
            const assertion = expect(p).rejects.toThrow(/timed out/i);
            await vi.advanceTimersByTimeAsync(1_001);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not reject one that IS answered in time', async () => {
        // Positive control: without it, "it times out" would also pass for a client
        // that times out immediately and always.
        vi.useFakeTimers();
        try {
            const f = fake();
            const c = new AcpClient(f.transport, { requestTimeoutMs: 1_000 });
            const p = c.request('initialize', {});
            f.deliver({ jsonrpc: '2.0', id: (f.sent[0] as { id: number }).id, result: 'ok' });
            await vi.advanceTimersByTimeAsync(2_000);
            await expect(p).resolves.toBe('ok');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('notifications from the agent', () => {
    it('dispatches them by method', () => {
        const f = fake();
        const c = new AcpClient(f.transport);
        const seen: unknown[] = [];
        c.onNotification('session/update', (p) => seen.push(p));

        f.deliver({ jsonrpc: '2.0', method: 'session/update', params: { sessionUpdate: 'notice' } });
        expect(seen).toEqual([{ sessionUpdate: 'notice' }]);
    });

    it('survives a notification nobody is listening for', () => {
        const f = fake();
        const c = new AcpClient(f.transport);
        expect(() => f.deliver({ jsonrpc: '2.0', method: 'who/knows', params: {} })).not.toThrow();
    });

    it('does not let a throwing handler kill the connection', async () => {
        // One bad listener must not stop the next message arriving. The agent is still
        // running and its turn is still going.
        const f = fake();
        const c = new AcpClient(f.transport);
        const seen: unknown[] = [];
        c.onNotification('session/update', () => {
            throw new Error('listener blew up');
        });
        c.onNotification('other', (p) => seen.push(p));

        expect(() => f.deliver({ jsonrpc: '2.0', method: 'session/update', params: {} })).not.toThrow();
        f.deliver({ jsonrpc: '2.0', method: 'other', params: { a: 1 } });
        expect(seen).toEqual([{ a: 1 }]);
        expect(c.closed).toBe(false);
    });
});

describe('requests FROM the agent', () => {
    it('answers one with a result on the same id', async () => {
        // session/request_permission and elicitation/create arrive this way. An
        // unanswered one parks the agent's turn forever.
        const f = fake();
        const c = new AcpClient(f.transport);
        c.onRequest('session/request_permission', async () => ({ outcome: 'allow' }));

        f.deliver({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: {} });
        await vi.waitFor(() => expect(f.sent).toHaveLength(1));
        expect(f.sent[0]).toEqual({ jsonrpc: '2.0', id: 7, result: { outcome: 'allow' } });
    });

    it('answers with an ERROR when no handler is registered', async () => {
        // Silence would park the agent. An error at least ends its wait and says why.
        const f = fake();
        const c = new AcpClient(f.transport);
        f.deliver({ jsonrpc: '2.0', id: 8, method: 'fs/write_text_file', params: {} });
        await vi.waitFor(() => expect(f.sent).toHaveLength(1));
        const reply = f.sent[0] as { id: number; error?: { message: string } };
        expect(reply.id).toBe(8);
        expect(reply.error?.message).toMatch(/fs\/write_text_file/);
    });

    it('answers with an error when the handler throws', async () => {
        const f = fake();
        const c = new AcpClient(f.transport);
        c.onRequest('session/request_permission', async () => {
            throw new Error('the human closed the window');
        });

        f.deliver({ jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: {} });
        await vi.waitFor(() => expect(f.sent).toHaveLength(1));
        const reply = f.sent[0] as { id: number; error?: { message: string } };
        expect(reply.error?.message).toMatch(/closed the window/);
    });
});
