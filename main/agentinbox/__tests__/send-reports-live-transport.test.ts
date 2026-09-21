import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import type { AgentInboxJoinInput } from '../types';

/**
 * A SEND MUST NOT CLAIM A DELIVERY IT CANNOT MAKE.
 *
 * Reported by claude:fancy after watching a codex sidecar's transport die across
 * three upgrades in one day:
 *
 *   > `agentinbox send` to that agent returned `{ ok: true, delivered: 1 }`. I
 *   > sent a full briefing — including an owner ruling that existed nowhere
 *   > else at the time — and reported to my owner that it had landed. It had
 *   > not. Nothing was listening.
 *
 * `diagnose` could see it — *"the database says connected while nothing is
 * listening"* — but `list` and `send` both actively assert health, and diagnose
 * is the one tool nobody runs unless already suspicious.
 *
 * WHAT IS NOT THE BUG: queuing for an agent that is merely AWAY. AgentInbox is
 * durable and pull-based by design, and mail waiting for an agent that will
 * poll again is delivered in every sense that matters. The failure is narrower
 * and worse — a transport the database calls bound while nothing holds it, so
 * the message waits for a reader that is never coming.
 *
 * So `delivered` keeps its meaning (it reached the durable inbox) and the send
 * result now carries whether a live transport took it. A caller that reports
 * success to a human can tell the two apart.
 */
function input(over: Partial<AgentInboxJoinInput> & { agentId: string }): AgentInboxJoinInput {
    return {
        terminalId: `t-${over.agentId}`,
        workspaceId: 'w1',
        workspaceName: 'Workspace One',
        slug: 'ws-one',
        agentType: 'claude',
        label: `Agent ${over.agentId}`,
        purpose: 'general',
        scope: 'all',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...over,
    };
}

describe('send reports whether a live transport took the message', () => {
    it('says live:false when the target requires a transport and none is bound', () => {
        const b = new AgentInboxBroker();
        b.join(input({ agentId: 'sender' }));
        b.join(input({ agentId: 'ghost', agentType: 'codex' }));
        // The registry says: nothing is bound for this agent right now. This is
        // exactly the post-upgrade state — the row survived, the binding did not.
        b.setTransportBoundResolver(() => false);

        const res = b.send({ fromAgentId: 'sender', toAgentId: 'ghost', text: 'briefing' });

        expect(res.ok).toBe(true);
        if (!res.ok) return;
        // Still queued — durable delivery is not in question.
        expect(res.delivered).toBe(1);
        // But the caller can now tell that nothing took it.
        expect(res.live).toBe(false);
        // The note has to say the thing that stops a caller reporting success:
        // nobody is listening. It names the agent too, because a sender with
        // several peers needs to know WHICH one went quiet.
        expect(String(res.note ?? '')).toMatch(/nothing is listening/i);
        expect(String(res.note ?? '')).toContain('Agent ghost');
    });

    it('says live:true when a transport IS bound', () => {
        // POSITIVE CONTROL. Without this, `live:false` could be a constant and
        // the assertion above would pass against a field that is never true.
        const b = new AgentInboxBroker();
        b.join(input({ agentId: 'sender' }));
        b.join(input({ agentId: 'bound', agentType: 'codex' }));
        b.setTransportBoundResolver(() => true);

        const res = b.send({ fromAgentId: 'sender', toAgentId: 'bound', text: 'hello' });

        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.live).toBe(true);
        expect(res.note).toBeUndefined();
    });

    it('does not cry wolf when no resolver is wired at all', () => {
        // The broker runs in tests and in contexts with no harness registry. An
        // unwired resolver means "unknown", which must not be reported as "not
        // listening" — a false alarm on every send would be its own bug.
        const b = new AgentInboxBroker();
        b.join(input({ agentId: 'sender' }));
        b.join(input({ agentId: 'peer' }));

        const res = b.send({ fromAgentId: 'sender', toAgentId: 'peer', text: 'hello' });

        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.delivered).toBe(1);
        expect(res.note).toBeUndefined();
    });
});

/**
 * A SEND TO AN ID THAT NO LONGER EXISTS.
 *
 * `claude:fancy` observed a sidecar's `agentId` CHANGE across an upgrade
 * (dd1a2bbc… → 8fbaf0d9…) and reasoned that a peer still holding the old
 * address would be sending into nothing. It was careful to label that an
 * inference — it switched to the new id rather than testing the dead one — and
 * to say why the difference matters:
 *
 *   > a rejected unknown id is survivable, a silently accepted one is not.
 *
 * Exactly right, so it is worth an assertion rather than a reading. This pins
 * the survivable behaviour so it cannot quietly become the other one.
 */
describe('a send addressed to an agent id that no longer exists', () => {
    it('is REJECTED, not accepted into nothing', () => {
        const b = new AgentInboxBroker();
        b.join(input({ agentId: 'sender' }));
        // 'ghost-gone' never joined — the shape of an id that was replaced by an
        // upgrade while a peer kept the old one.
        const res = b.send({ fromAgentId: 'sender', toAgentId: 'ghost-gone', text: 'briefing' });

        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.error).toContain('ghost-gone');
        // And it must not claim a delivery on the way out.
        expect(res.delivered ?? 0).toBe(0);
    });

    it('POSITIVE CONTROL: the same send to a live id succeeds', () => {
        // Without this, the rejection above would also pass if `send` were
        // broken for every target.
        const b = new AgentInboxBroker();
        b.join(input({ agentId: 'sender' }));
        b.join(input({ agentId: 'real' }));

        const res = b.send({ fromAgentId: 'sender', toAgentId: 'real', text: 'hello' });

        expect(res.ok).toBe(true);
    });
});
