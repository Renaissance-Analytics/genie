import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import type { AgentInboxJoinInput } from '../types';

/**
 * "It did not deliver" is three different facts (genie#462).
 *
 * `deliverHumanMessageToTerminal` answers with one boolean, and `false` covers
 * two unrelated situations: the terminal has no registered agent at all (closed,
 * or never joined), and the broker looked at the message and declined it. A
 * caller that has to EXPLAIN the failure to a person — the ArtBoard panel does —
 * cannot tell them apart, so it guesses, and the guess it shipped with ("the
 * agent is no longer running") was wrong for the whole life of the feature.
 *
 * The reason-carrying twin exists for those callers. The boolean stays, and is
 * DERIVED from it rather than implemented twice: two implementations of "did it
 * land" is how the two answers drift apart.
 */
function joined(over: Partial<AgentInboxJoinInput> = {}): AgentInboxJoinInput {
    return {
        agentId: 'A',
        terminalId: 'term-7',
        workspaceId: 'w1',
        workspaceName: 'Workspace One',
        slug: 'ws-one',
        agentType: 'claude',
        label: 'Agent A',
        purpose: 'general',
        scope: 'self',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...over,
    };
}

describe('deliverHumanMessageToTerminalResult — WHY a delivery failed', () => {
    it('reports a delivery that landed', () => {
        // POSITIVE CONTROL. Both refusals below are indistinguishable from a
        // broker that can no longer deliver anything at all.
        const b = new AgentInboxBroker();
        b.join(joined());
        expect(b.deliverHumanMessageToTerminalResult('term-7', 'the verdict')).toEqual({
            ok: true,
        });
    });

    it('names a terminal with no agent on it', () => {
        const b = new AgentInboxBroker();
        b.join(joined());
        const r = b.deliverHumanMessageToTerminalResult('term-nobody', 'the verdict');
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toBe('no-agent');
    });

    it('names a message the broker itself refused', () => {
        // A live agent on a real terminal — the difference from the case above is
        // the MESSAGE, not the recipient. Empty text is the refusal `send`
        // already has; what matters is that the reason survives the return trip.
        const b = new AgentInboxBroker();
        b.join(joined());
        const r = b.deliverHumanMessageToTerminalResult('term-7', '   ');
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toBe('refused');
        expect(!r.ok && r.error).toBeTruthy();
    });

    it('keeps the boolean method answering exactly as before', () => {
        // The four existing callers ask a yes/no question and are right to. The
        // point is that they read the SAME decision, not a second copy of it.
        const b = new AgentInboxBroker();
        b.join(joined());
        expect(b.deliverHumanMessageToTerminal('term-7', 'hello')).toBe(true);
        expect(b.deliverHumanMessageToTerminal('term-nobody', 'hello')).toBe(false);
        expect(b.deliverHumanMessageToTerminal('term-7', '  ')).toBe(false);
    });
});
