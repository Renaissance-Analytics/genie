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

    /**
     * GENIE LENDS THE AGENT NOTHING. This is the decision, and it is load-bearing.
     *
     * ACP lets a CLIENT offer capabilities the agent may then call back into —
     * `terminal/create|output|kill|wait_for_exit|release` to run commands on its behalf,
     * and `fs/read_text_file|write_text_file` to touch the disk. Genie declares neither, so
     * a well-behaved agent never asks: it uses its own Bash/Read/Edit tools inside the child
     * process Genie spawned, with Genie controlling `cwd` and `env`.
     *
     * That IS the point of moving to ACP — the agent stops being a terminal. Advertising
     * `terminal` would put one straight back, in the other direction: Genie executing
     * whatever the agent asked for.
     *
     * Asserted because the Genie 2 plan says the opposite. It lists `terminal/*` under
     * "ACP requests Genie must SERVE", and an `AcpTerminalService` was built, unit-tested,
     * and never wired to anything — dead for as long as it existed, because nothing
     * advertised the capability that would make an agent call it. It has been deleted; this
     * test is what stops the next reader of that plan quietly re-adding the capability and
     * handing the agent a shell.
     *
     * If serving terminals is ever WANTED — to confine the agent's commands to Genie's pty
     * host for auditability — it is a deliberate product change that starts by failing here.
     */
    it('declares NO terminal capability, and declines fs, so the agent runs its own tools', async () => {
        const { deps: d, calls } = deps();
        await new AcpSessionDriver(d).start({ cwd: '/repo' });

        const init = calls.find((c) => c.method === 'initialize')?.params as {
            clientCapabilities?: Record<string, unknown>;
        };
        expect(init).toBeTruthy();
        const caps = init.clientCapabilities ?? {};

        // Absent, not false: the protocol reads an absent capability as unsupported, and
        // `terminal: false` would be a claim we support the shape and declined.
        expect(caps).not.toHaveProperty('terminal');
        expect(JSON.stringify(caps)).not.toMatch(/terminal/i);

        // fs is declared and explicitly refused, which is the documented shape for it.
        expect(caps.fs).toEqual({ readTextFile: false, writeTextFile: false });
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

/**
 * RESUMING a conversation — `session/load`, and the id it must be given.
 *
 * Available from prism-acp 0.3.0, which fixed three stacked defects: the CLI's id was
 * recorded as unmapped and reached no client; exited sessions were never removed from the
 * agent's map, so a crashed agent came back as `already open` (the very case resume exists
 * for); and the map was keyed by the ACP id, so a load by CLI id could not collide with a
 * live session.
 *
 * ## Which id, and why it matters more than it looks
 *
 * `session/new` returns an id prism-acp MINTS (`sess_<n>_<timestamp>`). The provider's own id
 * is a different string, captured from `_meta` and stored on the agent record. **`session/load`
 * takes the provider's.**
 *
 * Measured by prism-acp against claude 2.1.292 rather than reasoned: a non-UUID gives *"is
 * not a UUID and does not match any session title"*, a well-formed unknown UUID gives *"No
 * conversation found with session ID"* — both `is_error: true`, zero turns, zero cost. So
 * this repository's standing doctrine, *"a wrong resume flag does not error, it starts a
 * FRESH conversation"*, is **false for `--resume`**. The real hazard is narrower and
 * worse-shaped: it errors ONE TURN TOO LATE, after the load has already reported success.
 * Which is exactly why the id is checked here and not discovered on the next prompt.
 */
describe('resume', () => {
    const CLI_ID = '9f1c2f84-0000-4000-8000-5a6b7c8d9e01';

    it('initializes, then LOADS, in that order', async () => {
        const { deps: d, calls } = deps();
        await new AcpSessionDriver(d).resume({ cwd: '/repo', sessionId: CLI_ID });
        expect(calls.map((c) => c.method)).toEqual(['initialize', 'session/load']);
    });

    it('passes the provider id and the cwd to session/load', async () => {
        const { deps: d, calls } = deps();
        await new AcpSessionDriver(d).resume({ cwd: '/repo', sessionId: CLI_ID });
        expect(calls[1]!.params).toMatchObject({ sessionId: CLI_ID, cwd: '/repo' });
    });

    it('opens NO new session — that is the whole difference from start()', async () => {
        // A `session/new` here would mint a second conversation and discard the one being
        // resumed, which is the bug this method exists to avoid.
        const { deps: d, calls } = deps();
        await new AcpSessionDriver(d).resume({ cwd: '/repo', sessionId: CLI_ID });
        expect(calls.some((c) => c.method === 'session/new')).toBe(false);
    });

    it('can be prompted afterwards, which is what "resumed" has to mean', async () => {
        // `session/load` returns `{}` and replays nothing, so the only proof a resume
        // WORKED is that the session is now promptable.
        const { deps: d, calls } = deps();
        const driver = new AcpSessionDriver(d);
        await driver.resume({ cwd: '/repo', sessionId: CLI_ID });
        await expect(driver.prompt('carry on')).resolves.toEqual({ delivered: true, submitted: true });
        expect(calls.some((c) => c.method === 'session/prompt')).toBe(true);
    });

    it('keeps the provider id as the session id, not a minted one', async () => {
        const { deps: d } = deps();
        const driver = new AcpSessionDriver(d);
        await driver.resume({ cwd: '/repo', sessionId: CLI_ID });
        expect(driver.sessionId).toBe(CLI_ID);
    });

    it('REFUSES an empty id rather than loading nothing', async () => {
        // An absent id means the provider never told us, so there is nothing to resume. A
        // load with a blank id is the late-error shape: accepted now, failing a turn later.
        const { deps: d, calls } = deps();
        await expect(new AcpSessionDriver(d).resume({ cwd: '/repo', sessionId: '  ' })).rejects.toThrow(
            /no session id/i,
        );
        expect(calls).toEqual([]);
    });

    it('propagates a refusal from the agent instead of reporting success', async () => {
        // prism-acp refuses an ACP id with a message naming the right key, and refuses a
        // load for an agent that is still running. Both must surface: a swallowed refusal
        // leaves a caller believing a conversation was continued when it was not.
        const { deps: d } = deps({
            request: async (method) => {
                if (method === 'session/load') throw new Error('session is already open');
                return {};
            },
        });
        await expect(
            new AcpSessionDriver(d).resume({ cwd: '/repo', sessionId: CLI_ID }),
        ).rejects.toThrow(/already open/i);
    });
});

/**
 * THE AGENT'S PERSONA AND OPENING INSTRUCTIONS.
 *
 * The pty path delivers these by TYPING them: `renderAgentLaunch` folds them into the launch
 * line as a positional prompt. An ACP session has no launch line, and before this `main/acp/`
 * contained no reference to instructions at all — so with ACP as the default, every agent
 * started with no persona. A GApp "Strategist" would have been a generic claude with no idea
 * it was a strategist.
 *
 * `main/terminal/ipc.ts` records that this exact bug already happened once on the pty side:
 * *"a project agent that was revived or restarted came back with no persona and no workspace
 * framing, silently."* Shipping ACP-mandatory without this would have reintroduced it for
 * every agent at once.
 *
 * ## Sent on a fresh start, NEVER on a resume
 *
 * A resumed conversation already contains them. Re-sending would open the continued
 * conversation by telling the agent who it is a second time — which reads as the agent having
 * forgotten, and spends a turn saying nothing new.
 */
describe('opening instructions', () => {
    const PERSONA = 'You are the Strategist. Read .agents/strategist.md.';

    it('are sent as the first prompt of a FRESH session', async () => {
        const { deps: d, calls } = deps();
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo', instructions: PERSONA });

        expect(calls.map((c) => c.method)).toEqual(['initialize', 'session/new', 'session/prompt']);
        expect(calls[2]!.params).toMatchObject({
            prompt: [{ type: 'text', text: PERSONA }],
        });
    });

    it('are NOT sent when there are none', async () => {
        const { deps: d, calls } = deps();
        await new AcpSessionDriver(d).start({ cwd: '/repo' });
        expect(calls.some((c) => c.method === 'session/prompt')).toBe(false);
    });

    it('are NOT sent on a RESUME, because the conversation already has them', async () => {
        const { deps: d, calls } = deps();
        await new AcpSessionDriver(d).resume({
            cwd: '/repo',
            sessionId: '9f1c2f84-0000-4000-8000-5a6b7c8d9e01',
            instructions: PERSONA,
        });
        expect(calls.map((c) => c.method)).toEqual(['initialize', 'session/load']);
    });

    it('ignores whitespace-only instructions rather than opening with a blank turn', async () => {
        const { deps: d, calls } = deps();
        await new AcpSessionDriver(d).start({ cwd: '/repo', instructions: '   ' });
        expect(calls.some((c) => c.method === 'session/prompt')).toBe(false);
    });
});

describe('heldApprovalIds — what a CANCEL is about to settle', () => {
    /**
     * A cancel answers every held permission with `cancelled` — the protocol's MUST, which this
     * driver already honours. The SURFACE has to find out: the session model holds those
     * approvals and nothing told it they were gone, so the Agent view would keep offering
     * Allow/Deny for decisions the agent had stopped waiting for. Pressing one does nothing,
     * which reads as Genie being broken rather than as a turn that has ended.
     *
     * Exposed as ids rather than as another callback because the caller already has the port it
     * needs (`onApprovalSettled` in `start.ts`), and because a list can be asserted.
     */
    const asking = (count = 1) =>
        deps({
            onRequest: (method, handler) => {
                if (method !== 'session/request_permission') return;
                for (let n = 0; n < count; n++) {
                    void handler({
                        sessionId: 'sess-1',
                        toolCall: { toolCallId: `tc${n}`, title: `Edit ${n}.ts` },
                        options: [{ optionId: 'o1', name: 'Allow', kind: 'allow_once' }],
                    });
                }
            },
        });

    it('is empty with nothing held', () => {
        expect(new AcpSessionDriver(deps().deps).heldApprovalIds()).toEqual([]);
    });

    it('names each held request by the id the HUMAN was shown', async () => {
        // The exposed id, not the internal handle: that is what the surface rendered and what
        // comes back from a click.
        const seen: string[] = [];
        const driver = new AcpSessionDriver(asking(2).deps);
        driver.onApproval((a) => seen.push(a.id));
        await driver.start({ cwd: '/repo' });

        await vi.waitFor(() => expect(seen).toHaveLength(2));
        expect(driver.heldApprovalIds()).toEqual(seen);
    });

    it('forgets one that has been decided', async () => {
        const seen: string[] = [];
        const driver = new AcpSessionDriver(asking(1).deps);
        driver.onApproval((a) => seen.push(a.id));
        await driver.start({ cwd: '/repo' });
        await vi.waitFor(() => expect(seen).toHaveLength(1));

        driver.decide(seen[0]!, 'allow-once');
        expect(driver.heldApprovalIds()).toEqual([]);
    });
});
