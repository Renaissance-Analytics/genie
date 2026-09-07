import { describe, expect, it } from 'vitest';
import { AgentInboxBroker, type NudgeDelivery } from '../broker';
import type { AgentInboxJoinInput } from '../types';

/**
 * The queued nudge, and the button that releases it (genie#333).
 *
 * When Genie is not sure the input box is empty it does not type: it parks the
 * notice and raises a banner with a "Send nudge" button. That button was inert
 * for the owner — clicking it did nothing, over a box they could see was empty —
 * because it re-asks the SAME question that parked the notice, and the answer
 * could never change.
 *
 * Two different faults live behind that one dead button, and they need
 * different answers:
 *
 *  - The box really is empty and Genie merely stopped tracking (one Escape).
 *    That is the model's bug, and the model is fixed: see ./draft.test.ts.
 *  - Genie believes there is text and the TUI has since cleared its own
 *    composer. Nothing in the input bytes can reveal that, so the person looking
 *    at the box says so, and Genie kills the line before it types.
 */
function join(b: AgentInboxBroker, id: string, extra: Partial<AgentInboxJoinInput> = {}): void {
    b.join({
        agentId: id,
        terminalId: `t-${id}`,
        workspaceId: 'ws1',
        workspaceName: 'WS One',
        slug: 'ws-one',
        agentType: 'claude',
        label: id,
        purpose: 'general',
        scope: 'all',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...extra,
    });
}

/** A broker with both agents joined, recording what reaches the pty. */
function staged(): {
    b: AgentInboxBroker;
    sent: NudgeDelivery[];
    pending: Array<{ terminalId: string; pending: boolean }>;
} {
    const b = new AgentInboxBroker();
    const sent: NudgeDelivery[] = [];
    const pending: Array<{ terminalId: string; pending: boolean }> = [];
    b.setWakeSink((d) => {
        sent.push(d);
    });
    b.setPendingNudgeSink((d) => pending.push(d));
    join(b, 'a');
    join(b, 'b');
    return { b, sent, pending };
}

/** Type at `t-b`, then DM it — the shape that parks a notice. */
function park(b: AgentInboxBroker, typed: string): void {
    b.noteUserInput('t-b', typed);
    b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'a message' });
}

describe('the queued nudge and the button that releases it', () => {
    it('an Escape no longer parks the notice at all', () => {
        // The live symptom, from the broker's end: dismissing a dialog used to
        // turn every later message into a banner nobody could clear.
        const { b, sent, pending } = staged();
        park(b, '\x1b');

        expect(pending).toEqual([]);
        expect(sent.map((d) => d.plan.mode)).toEqual(['submit']);
    });

    it('a genuinely typed draft still parks the notice and still refuses the button', () => {
        // POSITIVE CONTROL. This is what the gate is FOR: a plain click must not
        // fire someone's half-written line off as the notice's turn.
        const { b, sent, pending } = staged();
        park(b, 'half a thought');

        expect(pending).toEqual([{ terminalId: 't-b', pending: true }]);
        expect(b.sendPendingNudge('t-b')).toEqual({ ok: false, reason: 'input-not-empty' });
        expect(sent).toEqual([]);
    });

    it('the person looking at the box can clear it and send', () => {
        // The case no model can reach: the TUI emptied its own composer, so
        // Genie's `text` is stale and every automatic answer is defer, forever.
        const { b, sent } = staged();
        park(b, 'the TUI has since cleared this');

        expect(b.sendPendingNudge('t-b', { clearInput: true })).toEqual({ ok: true });
        expect(sent.map((d) => d.plan.mode)).toEqual(['clear-and-submit']);
        expect(sent[0]!.text).toContain('message');
    });

    it('clearing re-syncs the model, so the next notice is typed straight in', () => {
        // The kill-line is Genie's OWN write and never reaches `noteUserInput`,
        // so nothing else would tell the model that the box is empty now.
        const { b, sent } = staged();
        park(b, 'stale text');
        b.sendPendingNudge('t-b', { clearInput: true });

        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'a second message' });
        expect(sent.map((d) => d.plan.mode)).toEqual(['clear-and-submit', 'submit']);
    });

    it('the button takes the queued notice down once it has been sent', () => {
        const { b, pending } = staged();
        park(b, 'stale text');
        b.sendPendingNudge('t-b', { clearInput: true });

        expect(pending).toEqual([
            { terminalId: 't-b', pending: true },
            { terminalId: 't-b', pending: false },
        ]);
        expect(b.sendPendingNudge('t-b', { clearInput: true })).toEqual({
            ok: false,
            reason: 'none',
        });
    });

    it('a refused delivery leaves the notice queued', () => {
        const b = new AgentInboxBroker();
        const pending: Array<{ terminalId: string; pending: boolean }> = [];
        b.setWakeSink(() => false); // the host is already holding that terminal
        b.setPendingNudgeSink((d) => pending.push(d));
        join(b, 'a');
        join(b, 'b');
        park(b, 'stale text');

        expect(b.sendPendingNudge('t-b', { clearInput: true })).toEqual({
            ok: false,
            reason: 'delivery-failed',
        });
        expect(pending).toEqual([{ terminalId: 't-b', pending: true }]);
    });

    it('re-registering an agent keeps its draft, and the override still works on it', () => {
        // The carry-across in `join` is deliberate: a re-join is a spec edit on a
        // LIVE pty, and resetting the draft there would submit over whatever the
        // person had typed. So the draft survives — and the human's override has
        // to work on the far side of it, or the banner is stuck exactly as before.
        const { b, sent } = staged();
        park(b, 'typed before the re-join');
        join(b, 'b', { label: 'renamed' });

        expect(b.sendPendingNudge('t-b')).toEqual({ ok: false, reason: 'input-not-empty' });
        expect(b.sendPendingNudge('t-b', { clearInput: true })).toEqual({ ok: true });
        expect(sent.map((d) => d.plan.mode)).toEqual(['clear-and-submit']);
    });

    it('nothing automatic ever asks for the box to be cleared', () => {
        // POSITIVE CONTROL for the whole feature: `clear-and-submit` destroys
        // whatever is in the box, so it may only ever come from a person.
        const { b, sent } = staged();
        b.noteUserInput('t-b', 'a real draft');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'one' });
        b.markTurnEnd('t-b');
        b.wakeTerminalIfIdle('t-b', 'two');

        expect(sent.map((d) => d.plan.mode)).not.toContain('clear-and-submit');
    });
});
