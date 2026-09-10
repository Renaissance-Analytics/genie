import { describe, expect, it, vi } from 'vitest';
import { AgentInboxBroker } from '../../agentinbox/broker';
import type { AgentInboxJoinInput } from '../../agentinbox/types';
import { messageUrgency } from '../../agentinbox/urgency';
import { AgentDrain, drainNudge, drainNudgeSender, type DrainTarget } from '../drain';

/**
 * THE ENVELOPE MUST NOT CONTRADICT THE LETTER (genie#602).
 *
 * The drain nudge is the one message Genie HOLDS AN UPGRADE waiting for. During
 * the .315→.316 upgrade an agent received it announced like this:
 *
 *   [Genie] You just received a message from Genie (no reply) as a DM. It is
 *   not urgent — check it when you are not busy: read it with the agentinbox
 *   tool (action: "receive").
 *
 * while the body of that same message said *"Stop work now"* and *"Genie is
 * holding the upgrade until every agent has answered"*. The envelope is what a
 * busy agent reads first, and it told the agent to finish what it was doing.
 *
 * The two could disagree because they were decided in different places: the
 * body by {@link drainNudge}, the urgency by whatever the CALL SITE passed —
 * and the call site passed nothing, which defaults to the weakest wording there
 * is. So these tests assert the whole path, from the drain's own nudge to the
 * bytes that land in the agent's terminal.
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

const target = (name: string): DrainTarget => ({
    agentId: `w1:${name}`,
    inboxAgentId: `inbox-${name}`,
    terminalId: `t-inbox-${name}`,
    name,
    workspaceId: 'w1',
});

/**
 * The REAL path: `drain-service.ts`'s wiring, a real broker with no harness
 * transport (so a DM produces a terminal notice), and the notice bytes that
 * reach the pty.
 */
function drainOneAgent(): string {
    const broker = new AgentInboxBroker();
    const pty = vi.fn((_d: { terminalId: string; text: string }) => true);
    broker.setWakeSink(pty);
    broker.join(join({ agentId: 'inbox-moic' }));

    const drain = new AgentDrain({
        // Byte-for-byte what `drain-service.ts` hands the drain.
        send: drainNudgeSender((sent) => broker.send(sent)),
    });
    void drain.begin([target('moic')]);
    drain.cancel();

    return String(pty.mock.calls[0]?.[0]?.text ?? '');
}

describe('the drain nudge announces itself as the showstopper it is', () => {
    it('never tells the agent the upgrade notice can wait', () => {
        // THE BUG, verbatim. The body says "Stop work now"; the envelope said
        // the opposite.
        const envelope = drainOneAgent();
        expect(envelope).not.toMatch(/not urgent/i);
        expect(envelope).not.toMatch(/when you are not busy/i);
    });

    it('tells the agent to STOP, in the envelope, before it opens anything', () => {
        const envelope = drainOneAgent();
        expect(envelope).toMatch(/stop/i);
    });

    it('says Genie is HELD on this agent answering, for everyone', () => {
        // What is actually true, and what "check it immediately" leaves out.
        const envelope = drainOneAgent();
        expect(envelope).toMatch(/hold(s|ing)/i);
        expect(envelope).toMatch(/for everyone/i);
    });

    it('still says how to read it — a notice with no instructions is noise', () => {
        // POSITIVE CONTROL for the three assertions above, which are all about
        // what the envelope must NOT say: this proves they are being made
        // against a real notice and not an empty string.
        const envelope = drainOneAgent();
        expect(envelope).toContain('[Genie]');
        expect(envelope).toContain('agentinbox');
        expect(envelope).toContain('receive');
    });

    it('does not tell a Manual agent to wait to be asked', () => {
        // The SECOND half of the same contradiction. The body already carried
        // `drainNudgeMode`'s "do this now rather than waiting to be asked";
        // the envelope closed with `inboxNoticeMode`'s "do not act on it unless
        // a person asks you to", wrapped around it.
        const envelope = drainOneAgent();
        expect(envelope).not.toMatch(/do not act on it unless a person asks/i);
        expect(envelope).toMatch(/rather than waiting to be asked/i);
    });

    it('never reads as a permission verdict', () => {
        // `agent-mode-is-guidance.test.ts`'s rule, restated for the new rung: a
        // mode is guidance, and no notice may tell an agent it is forbidden.
        const envelope = drainOneAgent();
        expect(envelope).not.toMatch(/you (are not allowed|may not|cannot|are forbidden)/i);
        expect(envelope).not.toMatch(/(denied|blocked|not permitted|no permission)/i);
    });
});

describe('the urgency is minted WITH the body, not beside it', () => {
    it('the drain’s own nudge declares itself a showstopper', () => {
        expect(drainNudge('manual').urgency).toBe('showstopper');
        expect(drainNudge('automated').urgency).toBe('showstopper');
    });

    it('the wiring cannot forward the body without the urgency', () => {
        // The exact line that shipped genie#602 lived in `drain-service.ts`,
        // which no test can import. This is that line, lifted somewhere it can
        // be asserted against.
        const sends: { text: string; urgency: string }[] = [];
        const send = drainNudgeSender((input) => {
            sends.push({ text: input.text, urgency: input.urgency });
            return { ok: true };
        });

        expect(send('inbox-moic', drainNudge('manual'))).toBe(true);
        expect(sends).toHaveLength(1);
        expect(sends[0]!.urgency).toBe('showstopper');
        expect(sends[0]!.text).toBe(drainNudge('manual').text);
    });

    it('a send the broker refuses is reported as NOT landed', () => {
        // A row the drain waits on forever is worse than one marked stuck, so
        // the adapter must not launder a refusal into a delivery.
        const send = drainNudgeSender(() => ({ ok: false }));
        expect(send('inbox-gone', drainNudge('manual'))).toBe(false);
    });
});

describe('a showstopper carries the attention mechanism it needs', () => {
    it('interrupts, and says so in the durable record', () => {
        // `interrupt` is what glows the terminal and arms the unACKed
        // escalation. It is DERIVED from the urgency, so a showstopper cannot
        // be declared and then arrive quietly.
        const broker = new AgentInboxBroker();
        broker.join(join({ agentId: 'inbox-moic' }));
        const sent = broker.send({
            system: true,
            toAgentId: 'inbox-moic',
            text: 'stop',
            urgency: 'showstopper',
        });

        expect(sent.ok).toBe(true);
        if (!sent.ok) return;
        expect(sent.message?.urgency).toBe('showstopper');
        expect(sent.message?.interrupt).toBe(true);
    });

    it('leaves an ordinary DM exactly the shape it has always been', () => {
        // POSITIVE CONTROL: this must not mark every message urgent.
        const broker = new AgentInboxBroker();
        broker.join(join({ agentId: 'inbox-moic' }));
        const sent = broker.send({ system: true, toAgentId: 'inbox-moic', text: 'fyi' });

        expect(sent.ok).toBe(true);
        if (!sent.ok) return;
        expect(sent.message?.urgency).toBeUndefined();
        expect(sent.message?.interrupt).toBeUndefined();
    });

    it('degrades a rehydrated message DOWNWARD-BUT-LOUD, never to normal', () => {
        // The store keeps `interrupt` and not `urgency`, so a message read back
        // after a restart reads `urgent`. That is right: a showstopper asserts
        // something is held RIGHT NOW, and the hold ended with the restart. What
        // it must never do is come back as ordinary mail.
        expect(messageUrgency({ interrupt: true })).toBe('urgent');
        expect(messageUrgency({})).toBe('normal');
        expect(messageUrgency({ urgency: 'showstopper', interrupt: true })).toBe('showstopper');
    });
});
