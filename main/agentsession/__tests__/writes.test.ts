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
