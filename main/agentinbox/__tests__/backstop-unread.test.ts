import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInboxBroker } from '../broker';
import { HarnessTransportRegistry } from '../harness-transport';
import { createHarnessTransportSink } from '../transport-sink';
import type { AgentInboxJoinInput } from '../types';

/**
 * genie#549 — the unread backstop asks the WRONG QUESTION.
 *
 * genie#344 shut two doors onto an attached agent's keyboard: the delivery-time
 * notice, and the five-minute unread deadline. Shutting the first is right — a
 * bound channel means the message has a route, and a notice on top would be a
 * second copy typed where nothing can tell it from the human.
 *
 * Shutting the second was not. `harnessOwnsDelivery` answers "is a channel
 * BOUND", and the deadline asks "did the agent READ it" — a strictly stronger
 * claim that a binding cannot support. On a machine where Claude Code declines
 * to register the channel (an org policy, a feature gate, a protocol era with no
 * unsolicited notification path — see `main/mcp/agent-config.ts`), the bridge
 * writes happily to a stdout nobody reads, the binding stays live because the
 * bridge keeps polling, and NOTHING ever asks again. Six Genie upgrade notices
 * and a human's answer sat unseen for five days that way, with no recovery path
 * of any kind.
 *
 * So the deadline is now armed on the honest signal — mail past the agent's
 * cursor — whatever transport is bound. A channel that delivers costs nothing,
 * because the agent's own read clears the deadline before it is ever due.
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
        scope: 'self',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...over,
    };
}

/** A broker wired exactly as background.ts wires it, over a fresh registry. */
function wired(): {
    broker: AgentInboxBroker;
    registry: HarnessTransportRegistry;
    pty: ReturnType<typeof vi.fn>;
} {
    const registry = new HarnessTransportRegistry();
    const broker = new AgentInboxBroker();
    const pty = vi.fn((_d: { terminalId: string; text: string }) => true);
    broker.setTransportSink(createHarnessTransportSink(registry));
    broker.setWakeSink(pty);
    broker.setHarnessAttachedResolver((agentId) => registry.isVerified(agentId));
    broker.join(input({ agentId: 'A', agentType: 'genie' }));
    broker.join(input({ agentId: 'B' }));
    return { broker, registry, pty };
}

/** A live Claude Channel: bound, and parked on its long-poll for the whole
 *  scenario, so the binding never lapses on liveness (genie#528) and every
 *  assertion below is about delivery rather than about a grace window. */
function liveChannel(registry: HarnessTransportRegistry): void {
    registry.bindPull('B', 'claude-channel');
    registry.notePullPollOpen('B');
}

/** What the PTY was actually made to type. */
function typed(pty: ReturnType<typeof vi.fn>): string[] {
    return pty.mock.calls.map((c) => (c[0] as { text: string }).text);
}

describe('the unread backstop arms on unread mail, not on an unbound keyboard (genie#549)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reminds a live channel THROUGH the channel, not at the prompt', async () => {
        // The owner's rule: an agent with a live channel gets its mail — and its
        // reminders — through that channel, never typed into its input, where
        // nothing can tell Genie's words from the human's. The bridge's parked
        // poll is where a channel's mail comes from, so that is where the
        // reminder goes.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { broker, registry, pty } = wired();
        liveChannel(registry);

        broker.markTurnEnd('t-B');
        vi.advanceTimersByTime(20_000);
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'read over the channel, never marked read' });
        // The bridge took it and went back to waiting, as a working one does.
        const handed = await broker.receive('B', { wait: true, acknowledge: false });
        const poll: { result?: Awaited<ReturnType<typeof broker.receive>> } = {};
        void broker
            .receive('B', { cursor: handed.cursor, wait: true, timeoutMs: 600_000, acknowledge: false })
            .then((r) => (poll.result = r));

        await vi.advanceTimersByTimeAsync(300_000);

        // Settled BY the reminder: the poll's own timeout is still minutes away.
        const reminded = poll.result;
        if (!reminded) throw new Error('the parked poll was never given the reminder');
        expect(reminded.messages.map((m) => m.text).join('')).toMatch(/1 unread AgentInbox message/);
        // A reminder is not mail: it moves no cursor and marks nothing read.
        expect(reminded.cursor).toBe(handed.cursor);
        expect(broker.unreadForTerminal('t-B').count).toBe(1);
        expect(pty).not.toHaveBeenCalled();
    });

    it('holds a reminder for a bridge that is between polls, rather than typing it', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { broker, registry, pty } = wired();
        liveChannel(registry);

        broker.markTurnEnd('t-B');
        vi.advanceTimersByTime(20_000);
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'handed over, then the poll returned' });
        const handed = await broker.receive('B', { wait: true, acknowledge: false });
        vi.advanceTimersByTime(300_000);

        const polled = broker.receive('B', { cursor: handed.cursor, wait: true, timeoutMs: 1_000, acknowledge: false });
        await vi.advanceTimersByTimeAsync(1_000);
        const next = await polled;

        expect(next.messages.map((m) => m.text).join('')).toMatch(/unread AgentInbox message/);
        expect(pty).not.toHaveBeenCalled();
    });

    it('reaches the prompt only when a reminded channel is STILL unread a full window later', () => {
        // genie#549's recovery path, kept for the one case that needs it: a
        // channel Claude Code silently declined. Six upgrade notices and a
        // human's answer once sat unseen for five days behind one. A channel
        // that works never gets here — the agent reads, or reads its reminder.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { broker, registry, pty } = wired();
        liveChannel(registry);

        broker.markTurnEnd('t-B');
        vi.advanceTimersByTime(20_000);
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'the channel swallowed this' });

        vi.advanceTimersByTime(300_000);
        expect(pty).not.toHaveBeenCalled();

        vi.advanceTimersByTime(300_000);
        expect(typed(pty).some((t) => /unread AgentInbox message/.test(t))).toBe(true);
        expect(broker.unreadForTerminal('t-B').count).toBe(1);
    });

    it('POSITIVE CONTROL: an agent that reads after its channel reminder is never typed at', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { broker, registry, pty } = wired();
        liveChannel(registry);

        broker.markTurnEnd('t-B');
        vi.advanceTimersByTime(20_000);
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'reminded, then read' });
        vi.advanceTimersByTime(300_000);

        await broker.receive('B', {});
        vi.advanceTimersByTime(900_000);

        expect(pty).not.toHaveBeenCalled();
        expect(broker.unreadForTerminal('t-B').count).toBe(0);
    });

    it('POSITIVE CONTROL: the same mail with no channel reaches the agent at once', () => {
        // The unbound half of the scenario above, to the byte. It proves the
        // delivery path and the wake sink are both live in it — so "the deadline
        // fired" above is about the deadline, not about a broker that would have
        // typed something no matter what.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { broker, pty } = wired();

        broker.markTurnEnd('t-B');
        vi.advanceTimersByTime(20_000);
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'no channel at all' });

        expect(typed(pty).some((t) => /You just received a message/.test(t))).toBe(true);
    });

    it('POSITIVE CONTROL: an agent that READ its mail is never woken', async () => {
        // genie#344's real guarantee, restated on the signal that can support
        // it. Without this the test above would pass against a broker that
        // simply nudges everyone, which is the noise #344 removed.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { broker, registry, pty } = wired();
        liveChannel(registry);

        broker.markTurnEnd('t-B');
        vi.advanceTimersByTime(20_000);
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'the channel delivered this' });

        // The consumer commits its own cursor — the only thing in the system
        // that knows the message was seen.
        await broker.receive('B', {});
        vi.advanceTimersByTime(300_000);

        expect(pty).not.toHaveBeenCalled();
        expect(broker.unreadForTerminal('t-B').count).toBe(0);
    });

    it('advances the cursor EXACTLY ONCE for a message it did deliver', async () => {
        // The other way to get this wrong: a cursor that never advances turns
        // delivery into infinite redelivery.
        const { broker, registry } = wired();
        liveChannel(registry);

        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'read me' });

        const first = await broker.receive('B', {});
        expect(first.messages.map((m) => m.text)).toEqual(['read me']);
        const second = await broker.receive('B', {});
        expect(second.messages).toEqual([]);
        expect(second.cursor).toBe(first.cursor);
    });

    it('POSITIVE CONTROL: the DEADLINE itself still fires for an unbound agent', () => {
        // The long-standing scenario the deadline was built for, unchanged: the
        // message lands first (its immediate notice spends the one wake this
        // idle period allows), and the turn ends after, which is what opens a
        // fresh one. Proves the five-minute path is reachable at all.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { broker, pty } = wired();

        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'nowhere else to go' });
        vi.advanceTimersByTime(50_000);
        broker.markTurnEnd('t-B');
        vi.advanceTimersByTime(300_000);

        expect(typed(pty).some((t) => /unread AgentInbox message/.test(t))).toBe(true);
    });

    it('still keeps the DELIVERY-TIME notice off a bound channel’s keyboard', () => {
        // The half of genie#344 that a binding really does support: the message
        // has a route, so Genie must not type a second copy the instant it
        // arrives. Only the five-minute deadline is allowed to reach the prompt.
        const { broker, registry, pty } = wired();
        liveChannel(registry);

        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'over the channel' });

        expect(pty).not.toHaveBeenCalled();
    });
});
