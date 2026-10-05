import { describe, expect, it, vi } from 'vitest';
import { AcpSessionDriver, type DriverDeps } from '../session';

/**
 * Driving one ACP session: handshake, prompt, cancel, and answering what the agent asks.
 *
 * Two things here are protocol obligations rather than preferences, and both are the kind
 * that strand an agent mid-turn if they are missed:
 *
 *  - **cancel only ASKS.** `session/cancel` requests the end of a turn; it does not end
 *    one. An agent that has stopped answering never honours it, so the driver needs its
 *    own deadline rather than waiting forever for a turn that is already gone.
 *  - **a pending permission MUST be answered `cancelled` when the turn is cancelled.**
 *    The schema says so in those words. An unanswered request parks the agent.
 */

const deps = (over: Partial<DriverDeps> = {}) => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const notes: Array<{ method: string; params: unknown }> = [];
    const d: DriverDeps = {
        request: async (method, params) => {
            calls.push({ method, params });
            if (method === 'session/new') return { sessionId: 'sess-1' };
            return {};
        },
        notify: (method, params) => notes.push({ method, params }),
        onRequest: () => {},
        onNotification: () => {},
        cancelGraceMs: 1_000,
        ...over,
    };
    return { deps: d, calls, notes };
};

describe('handshake', () => {
    it('initializes, then opens a session, in that order', async () => {
        const { deps: d, calls } = deps();
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });

        expect(calls.map((c) => c.method)).toEqual(['initialize', 'session/new']);
        expect(driver.sessionId).toBe('sess-1');
    });

    it('passes the working directory to session/new', async () => {
        const { deps: d, calls } = deps();
        await new AcpSessionDriver(d).start({ cwd: '/repo' });
        expect((calls[1]!.params as { cwd: string }).cwd).toBe('/repo');
    });

    it('refuses to prompt before a session exists', async () => {
        // Prompting with no sessionId would be answered with a protocol error that reads
        // as "the agent rejected your message".
        const { deps: d } = deps();
        await expect(new AcpSessionDriver(d).prompt('hello')).rejects.toThrow(/no session/i);
    });

    it('surfaces a handshake failure instead of pretending it started', async () => {
        const { deps: d } = deps({
            request: async (method) => {
                if (method === 'initialize') throw new Error('auth required');
                return {};
            },
        });
        await expect(new AcpSessionDriver(d).start({ cwd: '/repo' })).rejects.toThrow(/auth required/);
    });
});

describe('prompt', () => {
    it('sends the text on the session', async () => {
        const { deps: d, calls } = deps();
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });
        await driver.prompt('do the thing');

        const sent = calls.find((c) => c.method === 'session/prompt');
        expect(sent).toBeTruthy();
        expect(sent!.params).toMatchObject({ sessionId: 'sess-1' });
        expect(JSON.stringify(sent!.params)).toContain('do the thing');
    });

    it('reports submission HONESTLY, because the transport can say so', async () => {
        // The whole point of ACP over a pty: `submit.ts` could only say "we could not
        // check". A resolved session/prompt is the agent acknowledging the turn.
        const { deps: d } = deps();
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });
        await expect(driver.prompt('x')).resolves.toMatchObject({ delivered: true, submitted: true });
    });

    it('does not claim submitted when the call failed', async () => {
        const { deps: d } = deps({
            request: async (method) => {
                if (method === 'session/new') return { sessionId: 'sess-1' };
                if (method === 'session/prompt') throw new Error('overloaded');
                return {};
            },
        });
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });
        await expect(driver.prompt('x')).rejects.toThrow(/overloaded/);
    });
});

describe('cancel', () => {
    it('sends session/cancel as a NOTIFICATION, not a request', async () => {
        // It is defined as a notification: there is no reply to wait for, and awaiting one
        // would hang.
        const { deps: d, notes } = deps();
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });
        await driver.cancel();
        expect(notes.map((n) => n.method)).toContain('session/cancel');
    });

    it('gives up after its own deadline, because cancel only ASKS', async () => {
        vi.useFakeTimers();
        try {
            const { deps: d } = deps({ cancelGraceMs: 500 });
            const driver = new AcpSessionDriver(d);
            await driver.start({ cwd: '/repo' });

            const p = driver.cancel();
            const assertion = expect(p).resolves.toMatchObject({ honoured: false });
            await vi.advanceTimersByTimeAsync(600);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports honoured when the turn actually ends in time', async () => {
        // Positive control. Without it "not honoured" would also pass for a driver that
        // never notices a turn ending.
        vi.useFakeTimers();
        try {
            const { deps: d } = deps({ cancelGraceMs: 5_000 });
            const driver = new AcpSessionDriver(d);
            await driver.start({ cwd: '/repo' });

            const p = driver.cancel();
            driver.noteTurnEnded();
            await vi.advanceTimersByTimeAsync(1);
            await expect(p).resolves.toMatchObject({ honoured: true });
        } finally {
            vi.useRealTimers();
        }
    });

    it('answers EVERY pending permission with cancelled', async () => {
        // The protocol's MUST, in its own words. An unanswered permission parks the agent
        // even after the turn is gone.
        const answers: unknown[] = [];
        const { deps: d } = deps({
            onRequest: (method, handler) => {
                if (method === 'session/request_permission') {
                    // Two in flight, neither answered by a human.
                    void handler({ sessionId: 'sess-1', options: [] }).then((r) => answers.push(r));
                    void handler({ sessionId: 'sess-1', options: [] }).then((r) => answers.push(r));
                }
            },
            cancelGraceMs: 10,
        });
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });
        await driver.cancel();

        await vi.waitFor(() => expect(answers).toHaveLength(2));
        expect(answers).toEqual([
            { outcome: { outcome: 'cancelled' } },
            { outcome: { outcome: 'cancelled' } },
        ]);
    });
});

describe('what the agent asks of us', () => {
    it('surfaces a permission request as an approval for a human', async () => {
        let captured: unknown = null;
        const { deps: d } = deps({
            onRequest: (method, handler) => {
                if (method === 'session/request_permission') {
                    void handler({
                        sessionId: 'sess-1',
                        toolCall: { toolCallId: 'tc1', title: 'Write ipc.ts' },
                        options: [{ optionId: 'o1', name: 'Allow', kind: 'allow_once' }],
                    });
                }
            },
        });
        const driver = new AcpSessionDriver(d);
        driver.onApproval((a) => {
            captured = a;
        });
        await driver.start({ cwd: '/repo' });

        await vi.waitFor(() => expect(captured).toBeTruthy());
        expect(captured).toMatchObject({ id: 'tc1', name: 'Write ipc.ts' });
    });

    it('resolves the agent request when the human decides', async () => {
        let answer: unknown = null;
        const { deps: d } = deps({
            onRequest: (method, handler) => {
                if (method === 'session/request_permission') {
                    void handler({
                        sessionId: 'sess-1',
                        toolCall: { toolCallId: 'tc1' },
                        options: [{ optionId: 'o1', name: 'Allow', kind: 'allow_once' }],
                    }).then((r) => {
                        answer = r;
                    });
                }
            },
        });
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });

        driver.decide('tc1', 'allow-once');
        await vi.waitFor(() => expect(answer).toBeTruthy());
        expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });
    });

    it('ignores a decision for an approval it is not holding', async () => {
        // A stale click, or a second one after the first resolved. It must not throw out
        // of a UI handler.
        const { deps: d } = deps();
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });
        expect(() => driver.decide('ghost', 'allow-once')).not.toThrow();
    });
});
