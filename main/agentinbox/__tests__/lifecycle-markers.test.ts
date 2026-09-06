import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import type {
    AgentInboxBrokerEvent,
    AgentInboxMessage,
    AgentInboxJoinInput,
    AgentInboxLifecycleMoment,
} from '../types';

/**
 * The broker's INBOX-LIFECYCLE events — the three of the five AgentPulse markers
 * that the messaging layer owns (delivered / checked / replied).
 *
 * The broker stays PURE: it does not know what a workspace row looks like and
 * never touches `agentPulse`. It reports the moment, with the workspace it
 * happened in, through the emitter presence.ts already wires. That is also what
 * makes these testable at all.
 *
 * ★ EVERY negative here is paired with its positive control in the same test.
 * "No marker on rehydrate" passes just as well against a broker that emits
 * nothing at all, so each case proves the live path DOES fire before asserting
 * the quiet path does not.
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

/** A broker recording only its lifecycle events. */
function withLifecycle(): {
    broker: AgentInboxBroker;
    moments: AgentInboxLifecycleMoment[];
} {
    const broker = new AgentInboxBroker();
    const moments: AgentInboxLifecycleMoment[] = [];
    broker.setEmitter((ev: AgentInboxBrokerEvent) => {
        if (ev.type === 'lifecycle') moments.push(ev.moment);
    });
    return { broker, moments };
}

/** Send, insisting it worked, and hand back the delivered message. Narrows the
 *  send result's union so a test reads the message without a non-null dance. */
function sent(
    broker: AgentInboxBroker,
    input: Parameters<AgentInboxBroker['send']>[0],
): AgentInboxMessage {
    const r = broker.send(input);
    if (!r.ok || !r.message) throw new Error(`send failed: ${r.ok ? 'no message' : r.error}`);
    return r.message;
}

describe('delivered — a message actually landing in an agent inbox', () => {
    it('fires with the RECIPIENT workspace, not the sender', () => {
        const { broker, moments } = withLifecycle();
        broker.join(input({ agentId: 'A', workspaceId: 'w1' }));
        broker.join(input({ agentId: 'B', workspaceId: 'w2', slug: 'ws-two' }));

        expect(broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'hi' }).ok).toBe(true);

        // The diamond belongs on B's row: B is the one that received something.
        expect(moments).toEqual([{ kind: 'delivered', workspaceId: 'w2', agentId: 'B' }]);
    });

    it('fires for a HUMAN message to a terminal, on the same path', () => {
        const { broker, moments } = withLifecycle();
        broker.join(input({ agentId: 'A', terminalId: 't-A' }));

        expect(broker.deliverHumanMessageToTerminal('t-A', 'from the human')).toBe(true);

        expect(moments).toEqual([{ kind: 'delivered', workspaceId: 'w1', agentId: 'A' }]);
    });

    it('does NOT fire when a REFUSED send delivers nothing', () => {
        const { broker, moments } = withLifecycle();
        broker.join(input({ agentId: 'A' }));
        // Positive control: a real delivery to a known agent DOES mark.
        broker.join(input({ agentId: 'B' }));
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'lands' });
        expect(moments).toHaveLength(1);

        // ...and an unknown recipient marks nothing, because nothing arrived.
        expect(broker.send({ fromAgentId: 'A', toAgentId: 'ghost', text: 'x' }).ok).toBe(false);
        expect(moments).toHaveLength(1);
    });
});

describe('checked — the agent read new mail', () => {
    it('fires when a read ADVANCES the cursor', async () => {
        const { broker, moments } = withLifecycle();
        broker.join(input({ agentId: 'A' }));
        broker.join(input({ agentId: 'B' }));
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'hi' });
        moments.length = 0;

        await broker.receive('B');

        expect(moments).toEqual([{ kind: 'checked', workspaceId: 'w1', agentId: 'B' }]);
    });

    it('does NOT fire on a read that returns nothing — with the control beside it', async () => {
        const { broker, moments } = withLifecycle();
        broker.join(input({ agentId: 'A' }));
        broker.join(input({ agentId: 'B' }));
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'hi' });
        moments.length = 0;

        // Positive control — the FIRST read consumes the message and marks.
        await broker.receive('B');
        expect(moments).toHaveLength(1);

        // The second read has nothing to consume: the cursor does not move, so
        // there was no moment. A green dot here would mean "it polled", which is
        // not what the marker claims.
        await broker.receive('B');
        expect(moments).toHaveLength(1);
    });

    it('does NOT fire when the caller declines to acknowledge', async () => {
        const { broker, moments } = withLifecycle();
        broker.join(input({ agentId: 'A' }));
        broker.join(input({ agentId: 'B' }));
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'hi' });
        moments.length = 0;

        await broker.receive('B', { acknowledge: false });
        expect(moments).toHaveLength(0);

        // Positive control: acknowledging the same message DOES mark, so the
        // absence above is the `acknowledge:false` and not a dead code path.
        await broker.receive('B');
        expect(moments).toEqual([{ kind: 'checked', workspaceId: 'w1', agentId: 'B' }]);
    });
});

describe('replied — DECLARED, never inferred', () => {
    it('fires only when the sender says what it is replying to', () => {
        const { broker, moments } = withLifecycle();
        broker.join(input({ agentId: 'A' }));
        broker.join(input({ agentId: 'B' }));
        const first = sent(broker, { fromAgentId: 'A', toAgentId: 'B', text: 'question?' });
        moments.length = 0;

        broker.send({
            fromAgentId: 'B',
            toAgentId: 'A',
            text: 'answer.',
            replyTo: first.id,
        });

        // Delivered on A's side AND replied on B's — one send, two moments, and
        // the reply is attributed to the agent that DID the replying.
        expect(moments).toEqual([
            { kind: 'delivered', workspaceId: 'w1', agentId: 'A' },
            { kind: 'replied', workspaceId: 'w1', agentId: 'B' },
        ]);
    });

    it('does NOT fire for an ordinary send between two agents that have talked', () => {
        const { broker, moments } = withLifecycle();
        broker.join(input({ agentId: 'A' }));
        broker.join(input({ agentId: 'B' }));
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'question?' });
        moments.length = 0;

        // This is EXACTLY the shape a pairKey heuristic would call a reply: B
        // messaging A after A messaged B. It is not one, because B did not say
        // it was. Inferring here was considered and rejected (owner, 2026-09-06).
        broker.send({ fromAgentId: 'B', toAgentId: 'A', text: 'unrelated thought' });

        expect(moments.some((m) => m.kind === 'replied')).toBe(false);
        // Positive control: the send really happened and really delivered.
        expect(moments).toEqual([{ kind: 'delivered', workspaceId: 'w1', agentId: 'A' }]);
    });

    it('does NOT fire for a HUMAN reply — the marker is about AGENT behaviour', () => {
        const { broker, moments } = withLifecycle();
        broker.join(input({ agentId: 'A' }));
        broker.join(input({ agentId: 'B' }));
        const first = sent(broker, { fromAgentId: 'A', toAgentId: 'B', text: 'q' });
        moments.length = 0;

        broker.send({ human: true, toAgentId: 'A', text: 'a', replyTo: first.id });

        expect(moments.some((m) => m.kind === 'replied')).toBe(false);
        expect(moments).toEqual([{ kind: 'delivered', workspaceId: 'w1', agentId: 'A' }]);
    });

    it('carries `replyTo` on the delivered MESSAGE, so a reader can follow it', () => {
        const { broker } = withLifecycle();
        broker.join(input({ agentId: 'A' }));
        broker.join(input({ agentId: 'B' }));
        const first = sent(broker, { fromAgentId: 'A', toAgentId: 'B', text: 'q' });
        const second = sent(broker, {
            fromAgentId: 'B',
            toAgentId: 'A',
            text: 'a',
            replyTo: first.id,
        });
        expect(second.replyTo).toBe(first.id);
        // ABSENT, not empty, when nothing is being replied to.
        expect('replyTo' in first).toBe(false);
    });
});

describe('boot rehydration is not activity', () => {
    it('re-queueing undelivered mail at boot marks NOTHING', () => {
        const { broker, moments } = withLifecycle();
        broker.join(input({ agentId: 'A' }));
        broker.join(input({ agentId: 'B' }));

        // Positive control: a live delivery on this very broker DOES mark, so the
        // silence below is rehydration and not an unwired emitter.
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'live' });
        expect(moments).toHaveLength(1);
        moments.length = 0;

        broker.rehydrateMessages();

        // A restart must not paint a row of diamonds for mail that arrived
        // yesterday — the marker is a moment, and this moment already passed.
        expect(moments).toHaveLength(0);
    });
});
