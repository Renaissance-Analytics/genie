import { describe, expect, it, vi } from 'vitest';
import { cancelSession, decideApproval, promptSession, type SessionWritePorts } from '../writes';

/**
 * THE WRITE PATH FROM THE UI — which did not exist.
 *
 * Measured before writing a line of this: `agentSession` over IPC was `list()` and nothing
 * else. `AgentView` takes `onApprove` and `onTakeOver` as optional callbacks and `master.tsx`
 * passed neither, there was no composer in the Conversation tab, and `terminal:write` sends raw
 * keystrokes to a pty — which for an ACP agent is an empty shell, not the agent.
 *
 * So with ACP as the mechanism and the Conversation tab as the default surface, **a human could
 * not prompt an agent, stop a turn, or answer a permission request from Genie's own UI.** Only
 * the MCP tools could, because `deliverTerminalInput` learned about ACP and the renderer never
 * did. A green suite reported all of this as finished.
 *
 * The decisions live here rather than in `main/ipc.ts`, which ships with no test at all.
 */

const ports = (over: Partial<SessionWritePorts> = {}): SessionWritePorts => ({
    promptFor: () => async () => ({ delivered: true, submitted: true }),
    cancelFor: () => async () => ({ honoured: true }),
    decideFor: () => () => {},
    allowTurn: () => true,
    ...over,
});

describe('promptSession', () => {
    it('sends the text to the session', async () => {
        const sent: string[] = [];
        const r = await promptSession(
            ports({ promptFor: () => async (t) => (sent.push(t), { delivered: true, submitted: true }) }),
            { specId: 's1', text: 'carry on' },
        );
        expect(sent).toEqual(['carry on']);
        expect(r).toEqual({ ok: true, delivered: true, submitted: true });
    });

    it('refuses when there is NO ACP session for that spec', async () => {
        // Every pty agent, and a closed channel. Named rather than silent: a send that reports
        // nothing is how the UI ends up claiming a prompt the agent never saw.
        const r = await promptSession(ports({ promptFor: () => null }), { specId: 's1', text: 'hi' });
        expect(r).toEqual({ ok: false, reason: 'no-session' });
    });

    it('refuses an EMPTY prompt without touching the session', async () => {
        // A stray Enter in the composer. Sending it starts a turn with no instruction, which
        // costs tokens and produces a shrug.
        const prompt = vi.fn();
        const r = await promptSession(ports({ promptFor: () => prompt as never }), {
            specId: 's1',
            text: '   ',
        });
        expect(r).toEqual({ ok: false, reason: 'empty' });
        expect(prompt).not.toHaveBeenCalled();
    });

    it('sends the text TRIMMED, because trailing whitespace is not instruction', async () => {
        const sent: string[] = [];
        await promptSession(
            ports({ promptFor: () => async (t) => (sent.push(t), { delivered: true, submitted: true }) }),
            { specId: 's1', text: '  do the thing  ' },
        );
        expect(sent).toEqual(['do the thing']);
    });

    it('PARKS the prompt when the agent is over its daily budget', async () => {
        // The owner's cap is about the SUBSCRIPTION, not about who typed — so it holds for a
        // human-driven turn too, and the gate ASKS rather than refusing silently, which puts the
        // numbers in front of the person at the moment they matter.
        const prompt = vi.fn();
        const r = await promptSession(
            ports({ allowTurn: () => false, promptFor: () => prompt as never }),
            { specId: 's1', text: 'again' },
        );
        expect(r).toEqual({ ok: false, reason: 'parked' });
        expect(prompt).not.toHaveBeenCalled();
    });

    it('reports a prompt the session did not take', async () => {
        // `delivered: false` is a real outcome — the channel went while the call was in flight.
        // Reported as such rather than thrown: the composer must be able to keep the text.
        const r = await promptSession(
            ports({ promptFor: () => async () => ({ delivered: false, submitted: false }) }),
            { specId: 's1', text: 'x' },
        );
        expect(r).toEqual({ ok: true, delivered: false, submitted: false });
    });

    it('reports a THROWN send rather than letting it escape the handler', async () => {
        // This is reached from an IPC handler; an unhandled rejection in the main process is a
        // worse outcome than a failed send the UI can show.
        const r = await promptSession(
            ports({
                promptFor: () => async () => {
                    throw new Error('channel closed');
                },
            }),
            { specId: 's1', text: 'x' },
        );
        expect(r).toEqual({ ok: false, reason: 'failed', error: 'channel closed' });
    });
});

/**
 * THE PROMPT IS PART OF THE CONVERSATION, and nothing was recording it.
 *
 * Measured against a real claude ACP session (`handshake.real.test.ts`, logged on every run):
 * `live=agent_message_chunk,notice,usage_update`, and `session/load` on the CLI's own session id
 * replays `(0) none`. The agent never echoes the client's prompt and never replays it, so after
 * the owner typed into the Conversation composer and `master.tsx` re-read the sessions, the
 * transcript held the reply and no record of the question.
 *
 * Genie knows what it sent, so Genie declares it — but ONLY once the session has taken it, because
 * a transcript claiming a prompt the agent never saw is the exact failure `no-session` exists to
 * report.
 */
describe('promptSession records what the owner said', () => {
    const recording = (over: Partial<SessionWritePorts> = {}) => {
        const recorded: Array<[string, string]> = [];
        const p = ports({ recordPrompt: (specId, text) => recorded.push([specId, text]), ...over });
        return { p, recorded };
    };

    it('records a DELIVERED prompt against its spec', async () => {
        const { p, recorded } = recording();
        await promptSession(p, { specId: 's1', text: '  carry on  ' });
        // The TRIMMED text, the same string the session was given -- not the raw composer value.
        expect(recorded).toEqual([['s1', 'carry on']]);
    });

    it('records NOTHING when there is no session', async () => {
        const { p, recorded } = recording({ promptFor: () => null });
        await promptSession(p, { specId: 's1', text: 'hi' });
        expect(recorded).toEqual([]);
    });

    it('records NOTHING when the budget gate parked the turn', async () => {
        const { p, recorded } = recording({ allowTurn: () => false });
        await promptSession(p, { specId: 's1', text: 'hi' });
        expect(recorded).toEqual([]);
    });

    it('records NOTHING for an empty prompt', async () => {
        const { p, recorded } = recording();
        await promptSession(p, { specId: 's1', text: '   ' });
        expect(recorded).toEqual([]);
    });

    /**
     * RECORDED BEFORE THE SEND, and the first version of this got it backwards.
     *
     * `session/prompt` resolves when the TURN COMPLETES, not when the agent receives the text — so
     * recording on a delivered outcome recorded it after every reply the turn produced. The owner's
     * question appeared BELOW its own answer, and against codex (which echoes the prompt during the
     * turn) a third copy landed at the end where no tail-match could collapse it.
     *
     * My own test for the ordering passed, because it called `recordHumanPromptForSpec` before
     * `apply` — the order I assumed rather than the order production produces. A test that stages the
     * sequence it wants is not evidence about the sequence that happens.
     *
     * So the three "never reached the agent" cases are exactly the three settled BEFORE the send —
     * empty text, no session, budget parked — and each is already a `return` above. Once the call is
     * made, the message is out: `delivered: false` means Genie could not CONFIRM it, not that the
     * agent did not get it, and erasing what the owner typed on an unconfirmed send is worse than
     * showing it. The composer keeps the text too, which is the separate half of the same decision.
     */
    it('records a prompt the channel could not CONFIRM, because it was still sent', async () => {
        const { p, recorded } = recording({
            promptFor: () => async () => ({ delivered: false, submitted: false }),
        });
        await promptSession(p, { specId: 's1', text: 'hi' });
        expect(recorded).toEqual([['s1', 'hi']]);
    });

    it('records a prompt whose send THREW, for the same reason', async () => {
        const { p, recorded } = recording({
            promptFor: () => async () => {
                throw new Error('socket closed');
            },
        });
        expect((await promptSession(p, { specId: 's1', text: 'hi' })).ok).toBe(false);
        expect(recorded).toEqual([['s1', 'hi']]);
    });

    it('records it BEFORE the session sees it, so the reply cannot land first', async () => {
        // The ordering, asserted on the sequence rather than assumed. `session/prompt` resolves at
        // the END of the turn, so anything recorded after it awaits sits below the whole reply.
        const order: string[] = [];
        const p = ports({
            recordPrompt: () => order.push('recorded'),
            promptFor: () => async () => {
                order.push('sent');
                return { delivered: true, submitted: true };
            },
        });
        await promptSession(p, { specId: 's1', text: 'go' });
        expect(order).toEqual(['recorded', 'sent']);
    });

    it('still sends when no recorder is wired at all', async () => {
        // Optional on purpose: a remote window or a test harness may have no declared store, and a
        // missing recorder must cost the owner a transcript line, never the message.
        const sent: string[] = [];
        const r = await promptSession(
            ports({ promptFor: () => async (t) => (sent.push(t), { delivered: true, submitted: true }) }),
            { specId: 's1', text: 'hi' },
        );
        expect(sent).toEqual(['hi']);
        expect(r.ok).toBe(true);
    });

    it('a THROWING recorder does not lose the send', async () => {
        // The order matters: the message is already with the agent by the time this runs, so a
        // failure to record must not turn a delivered prompt into a reported failure.
        const r = await promptSession(
            ports({
                recordPrompt: () => {
                    throw new Error('store gone');
                },
            }),
            { specId: 's1', text: 'hi' },
        );
        expect(r).toEqual({ ok: true, delivered: true, submitted: true });
    });
});

describe('cancelSession', () => {
    it('asks the agent to stop, and reports whether it complied', async () => {
        expect(await cancelSession(ports(), { specId: 's1' })).toEqual({ ok: true, honoured: true });
        expect(
            await cancelSession(ports({ cancelFor: () => async () => ({ honoured: false }) }), {
                specId: 's1',
            }),
        ).toEqual({ ok: true, honoured: false });
    });

    it('is NOT gated by the budget, because stopping is always allowed', async () => {
        // A cap exists to stop work starting. Refusing to stop work already running because of
        // a cap would be the opposite of what it is for.
        expect(await cancelSession(ports({ allowTurn: () => false }), { specId: 's1' })).toEqual({
            ok: true,
            honoured: true,
        });
    });

    it('refuses when there is no session', async () => {
        expect(await cancelSession(ports({ cancelFor: () => null }), { specId: 's1' })).toEqual({
            ok: false,
            reason: 'no-session',
        });
    });
});

describe('decideApproval', () => {
    it('passes the decision to the session', () => {
        const calls: Array<[string, string]> = [];
        const r = decideApproval(
            ports({ decideFor: () => (id, d) => calls.push([id, d]) }),
            { specId: 's1', approvalId: 'p1', decision: 'allow-once' },
        );
        expect(calls).toEqual([['p1', 'allow-once']]);
        expect(r).toEqual({ ok: true });
    });

    it('carries every decision the protocol has, including the ALWAYS forms', () => {
        // `allow-always` and `deny-always` map to real option kinds; dropping them would quietly
        // turn "don't ask again" into "ask me every time".
        const calls: string[] = [];
        for (const d of ['allow-once', 'allow-always', 'deny-once', 'deny-always'] as const) {
            decideApproval(ports({ decideFor: () => (_id, got) => calls.push(got) }), {
                specId: 's1',
                approvalId: 'p1',
                decision: d,
            });
        }
        expect(calls).toEqual(['allow-once', 'allow-always', 'deny-once', 'deny-always']);
    });

    it('is NOT gated by the budget — answering is not starting work', () => {
        expect(
            decideApproval(ports({ allowTurn: () => false }), {
                specId: 's1',
                approvalId: 'p1',
                decision: 'deny-once',
            }),
        ).toEqual({ ok: true });
    });

    it('refuses when there is no session', () => {
        expect(
            decideApproval(ports({ decideFor: () => null }), {
                specId: 's1',
                approvalId: 'p1',
                decision: 'allow-once',
            }),
        ).toEqual({ ok: false, reason: 'no-session' });
    });
});
