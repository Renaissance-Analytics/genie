import { describe, expect, it, vi } from 'vitest';
import { AgentInboxBroker } from '../../agentinbox/broker';
import { askUrgency } from '../../agentinbox/urgency';
import { drainNudge } from '../drain';
import type { AgentInboxJoinInput } from '../../agentinbox/types';
import {
    AgentShutdownReadiness,
    shutdownAsk,
    shutdownAskSender,
    type ShutdownAgentTarget,
} from '../shutdown-readiness';

/**
 * THE QUIT-TIME ASK IS AN ASK (genie#606).
 *
 * genie#602 fixed the UPGRADE DRAIN's notice. Its twin was left saying exactly
 * what the drain's used to. The full-shutdown readiness barrier asks an agent to
 *
 *   Finish or checkpoint current work, then call thumbsUp with reason
 *   "shutdown" when it is safe to stop this agent.
 *
 * and announced that as *"It is not urgent — check it when you are not busy …
 * You are a Manual agent. This is for your awareness — do not act on it unless a
 * person asks you to."*
 *
 * Both halves are wrong, and they are wrong in the two ways genie#602 named:
 * the RUNG (this is Genie waiting on an answer, not mail) and the MODE CLAUSE
 * (the body asks the agent to act; the envelope told it not to).
 *
 * A third thing is missing from BOTH halves, and it is the one that changes
 * behaviour: Genie quits after about thirty seconds either way. An agent that
 * knows it has seconds checkpoints; one that thinks it has as long as it needs
 * does not; one that thinks nothing is happening does nothing at all.
 */

function join(over: Partial<AgentInboxJoinInput> & { agentId: string }): AgentInboxJoinInput {
    return {
        terminalId: `t-${over.agentId}`,
        workspaceId: 'w1',
        workspaceName: 'Workspace One',
        slug: 'ws-one',
        agentType: 'claude',
        label: `Agent ${over.agentId}`,
        purpose: 'general',
        scope: 'self',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...over,
    };
}

const target: ShutdownAgentTarget = {
    agentId: 'w1:moic',
    inboxAgentId: 'inbox-moic',
    terminalId: 't-inbox-moic',
};

/**
 * The REAL path: `shutdown-readiness.ts`'s own wiring, a real broker with no
 * harness transport (so the DM produces a terminal notice), and the bytes that
 * reach the pty.
 */
function askOneAgent(): string {
    const broker = new AgentInboxBroker();
    const pty = vi.fn((_d: { terminalId: string; text: string }) => true);
    broker.setWakeSink(pty);
    broker.join(join({ agentId: 'inbox-moic' }));

    const readiness = new AgentShutdownReadiness({
        // Byte-for-byte what `shutdown-readiness.ts` wires up.
        send: shutdownAskSender((sent) => broker.send(sent)),
    });
    void readiness.begin([target], 30_000);
    // Settle it rather than leaving a live 30-second timer behind.
    readiness.acknowledge(target.agentId, 'shutdown');

    return String(pty.mock.calls[0]?.[0]?.text ?? '');
}

describe('the full-shutdown ask announces itself as an ask', () => {
    it('never tells the agent it can wait', () => {
        // THE BUG. The body asks it to checkpoint and answer; the envelope said
        // to get to it when it was free — and Genie quits in thirty seconds.
        const envelope = askOneAgent();
        expect(envelope).not.toMatch(/not urgent/i);
        expect(envelope).not.toMatch(/when you are not busy/i);
    });

    it('does not tell a Manual agent to wait to be asked', () => {
        // A person HAS asked: they are quitting Genie. The envelope closed with
        // "do not act on it unless a person asks you to", wrapped around a body
        // asking the agent to act.
        const envelope = askOneAgent();
        expect(envelope).not.toMatch(/do not act on it unless a person asks/i);
    });

    it('says how long the agent actually has', () => {
        // Genie goes ahead either way. That is the fact that decides whether an
        // agent checkpoints or finishes its thought first.
        const envelope = askOneAgent();
        expect(envelope).toMatch(/30 seconds/);
    });

    it('still says how to read it, and who it is from', () => {
        // POSITIVE CONTROL for the three above, which are all about what the
        // envelope must NOT say: this proves they run against a real notice.
        const envelope = askOneAgent();
        expect(envelope).toContain('[Genie]');
        expect(envelope).toContain('agentinbox');
        expect(envelope).toContain('receive');
    });

    it('never reads as a permission verdict', () => {
        // `agent-mode-is-guidance.test.ts`'s rule: a mode is guidance, and no
        // notice may tell an agent it is forbidden.
        const envelope = askOneAgent();
        expect(envelope).not.toMatch(/you (are not allowed|may not|cannot|are forbidden)/i);
        expect(envelope).not.toMatch(/\b(denied|blocked|not permitted|no permission)\b/i);
    });
});

describe('the rung is EARNED, and a clock does not earn a showstopper', () => {
    it('is urgent \u2014 nothing is held, so nothing may claim to be', () => {
        // The overstatement guard. `showstopper` asserts "Genie is holding
        // until your answer arrives"; on a thirty-second clock that is false,
        // and a rung that lies is the genie#602 defect pointed the other way.
        expect(askUrgency(shutdownAsk('manual', 30).ask)).toBe('urgent');
        expect(askUrgency(drainNudge('manual').ask)).toBe('showstopper');
    });

    it('says Genie goes ahead either way \u2014 the drain says the opposite', () => {
        // The two asks differ in the one fact that decides what an agent does
        // first: finish the thought, or save the state.
        const quit = shutdownAsk('manual', 30).text;
        expect(quit).toMatch(/goes ahead in about 30 seconds/);
        expect(quit).toMatch(/not a gate/i);
        expect(drainNudge('manual').text).not.toMatch(/not a gate/i);
        expect(drainNudge('manual').text).toMatch(/holding the upgrade/i);
    });

    it('a clocked ask is never announced as ordinary mail', () => {
        // It shares the `urgent` rung with a peer's interrupt DM, and must not
        // share its sentence: "check it immediately" says nothing about Genie
        // being about to quit out from under the agent.
        const envelope = askOneAgent();
        expect(envelope).toMatch(/Genie is ASKING/);
        expect(envelope).not.toMatch(/marked HIGH PRIORITY/);
    });
});

describe('the terms the agent is told are the terms the barrier keeps', () => {
    it('reads the deadline off the SAME argument that arms the timer', () => {
        // A notice promising thirty seconds while the barrier waits five would
        // be a new way to say the wrong thing, so the number has one source.
        const sends: string[] = [];
        const readiness = new AgentShutdownReadiness({
            send: (_to, notice) => {
                sends.push(notice.text);
                return true;
            },
        });
        void readiness.begin([target], 5_000);
        readiness.acknowledge(target.agentId, 'shutdown');

        expect(sends).toHaveLength(1);
        expect(sends[0]!).toMatch(/about 5 seconds/);
        expect(sends[0]!).not.toMatch(/30 seconds/);
    });

    it('the wiring cannot forward the body without its terms', () => {
        // `shutdown-readiness.ts`'s singleton reaches for the real broker, so
        // this is that wiring lifted somewhere it can be asserted against.
        const sends: { text: string; deadlineSeconds: number | null }[] = [];
        const send = shutdownAskSender((input) => {
            sends.push({ text: input.text, deadlineSeconds: input.ask.deadlineSeconds });
            return { ok: true };
        });

        expect(send('inbox-moic', shutdownAsk('manual', 30))).toBe(true);
        expect(sends).toHaveLength(1);
        expect(sends[0]!.deadlineSeconds).toBe(30);
        expect(sends[0]!.text).toBe(shutdownAsk('manual', 30).text);
    });

    it('one agent that cannot be reached does not cost the others the ask', () => {
        // The barrier proceeds on a clock either way, so a throwing send must
        // not take the rest of the fleet's warning with it.
        const reached: string[] = [];
        const readiness = new AgentShutdownReadiness({
            send: (to) => {
                if (to === 'inbox-a') throw new Error('gone');
                reached.push(to);
                return true;
            },
        });
        void readiness.begin(
            [
                { agentId: 'a', inboxAgentId: 'inbox-a', terminalId: 't-a' },
                { agentId: 'b', inboxAgentId: 'inbox-b', terminalId: 't-b' },
            ],
            30_000,
        );
        readiness.acknowledge('a', 'shutdown');
        readiness.acknowledge('b', 'shutdown');

        expect(reached).toEqual(['inbox-b']);
    });

    it('an unreadable mode costs the wording, never the ask', () => {
        const sends: string[] = [];
        const readiness = new AgentShutdownReadiness({
            send: (_to, notice) => {
                sends.push(notice.text);
                return true;
            },
            modeOf: () => {
                throw new Error('no such agent');
            },
        });
        void readiness.begin([target], 30_000);
        readiness.acknowledge(target.agentId, 'shutdown');

        // Degraded to Manual — the direction that tells an agent to do less on
        // its own — but the ask itself still went.
        expect(sends).toHaveLength(1);
        expect(sends[0]!).toBe(shutdownAsk('manual', 30).text);
    });
});
