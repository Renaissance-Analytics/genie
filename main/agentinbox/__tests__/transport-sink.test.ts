import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInboxBroker } from '../broker';
import { HarnessTransportRegistry } from '../harness-transport';
import { createHarnessTransportSink } from '../transport-sink';
import type { AgentInboxJoinInput } from '../types';

/**
 * genie#344 — AgentInbox delivered to Claude agents by TYPING INTO THE PTY.
 *
 * The sink that routes a message to an agent's harness was hard-coded to
 * `codex-app-server`; every other provider was told `false`, which the broker
 * reads as "the harness declined" and answers with the PTY nudge. So an inbox
 * notice for a Claude agent landed in its conversation as USER INPUT,
 * indistinguishable from something the human typed — while its channel, which
 * had the message all along, was treated as though it did not exist.
 *
 * These tests fix the routing at the seam where it went wrong, and pin the
 * fallback that must survive it.
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

/** Let the transport's promise chain settle (deliver → send → ACK). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

describe('AgentInbox harness transport sink (genie#344)', () => {
    it('delivers to a bound Claude channel and NEVER types at its prompt', async () => {
        const { broker, registry, pty } = wired();
        registry.bindPull('B', 'claude-channel');

        // The Claude Channel bridge's live connection: a blocking `receive`
        // parked on the durable inbox, exactly as `claudeChannelBridge()` holds
        // one. Nothing else about this test asserts that mail MOVED, so without
        // it "the PTY was not used" would pass just as well against an agent
        // that received nothing at all.
        const channel = broker.receive('B', { cursor: 0, wait: true, acknowledge: false });

        expect(broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'over the channel' }).ok)
            .toBe(true);

        // POSITIVE CONTROL — the message really did arrive over the channel.
        await expect(channel).resolves.toMatchObject({
            messages: [expect.objectContaining({ text: 'over the channel' })],
        });
        // ...and the defect: not one byte at the keyboard.
        expect(pty).not.toHaveBeenCalled();
    });

    it('leaves a pull transport to ACK its own mail', async () => {
        // The channel ACKs only after its stdout accepts the notification, so
        // Genie must not mark the message read on its behalf — a crash between
        // the two would lose it silently.
        const { broker, registry, pty } = wired();
        registry.bindPull('B', 'claude-channel');

        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'not yours to ACK' });
        await settle();

        expect(broker.unreadForTerminal('t-B').count).toBe(1);
        // Unread must mean "the channel has not read it yet", never "the PTY
        // fallback ran" — which is the only other way this count stays at 1.
        expect(pty).not.toHaveBeenCalled();
    });

    it('still host-pushes to Codex and ACKs once App Server takes it', async () => {
        const { broker, registry, pty } = wired();
        const send = vi.fn(async () => undefined);
        registry.bind('B', 'codex-app-server', send);

        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'pushed' });
        await settle();

        expect(send).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'pushed', priority: 'normal' }),
        );
        expect(broker.unreadForTerminal('t-B').count).toBe(0);
        expect(pty).not.toHaveBeenCalled();
    });

    it('falls back to the PTY nudge when NO transport is bound', () => {
        // Removing this path is not the goal: an agent running in a terminal
        // with no harness channel would otherwise never learn it has mail.
        const { broker, pty } = wired();

        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'nowhere else to go' });

        expect(pty).toHaveBeenCalledTimes(1);
        expect(pty.mock.calls[0]![0]).toMatchObject({ terminalId: 't-B' });
    });

    it('falls back to the PTY again once a dead channel is released', () => {
        // A pull binding outliving its holder would swallow mail forever, so
        // releasing it must put the fallback back exactly as it was.
        const { broker, registry, pty } = wired();
        registry.bindPull('B', 'claude-channel');
        registry.unbindPull('B');

        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'channel is gone' });

        expect(pty).toHaveBeenCalledTimes(1);
    });
});

/**
 * The OTHER door onto the same keyboard.
 *
 * Fixing the sink stops the delivery-time notice, but the unread backstop is
 * armed from `markTurnEnd`, not from delivery — so an attached agent that had
 * not yet drained its channel still got "you have N unread" typed at its prompt
 * five minutes later. `deliverToHarness` never ran for it; the sink never saw
 * it. Both doors have to shut, or the fix only moves when the PTY is used.
 */
describe('the unread-mail backstop respects a live harness transport', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    /** Drive an agent to the exact point the backstop is due. */
    function runToBackstop(bind: boolean): ReturnType<typeof vi.fn> {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { broker, registry, pty } = wired();
        if (bind) registry.bindPull('B', 'claude-channel');

        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'unread mail' });
        // The agent finishes a turn without having read it — which is what arms
        // the five-minute deadline.
        vi.advanceTimersByTime(50_000);
        broker.markTurnEnd('t-B');
        // Past NUDGE_UNCHECKED_MS from the message, and long past the quiet
        // window, so the deadline is both warranted and safe.
        vi.advanceTimersByTime(300_000);
        return pty;
    }

    it('POSITIVE CONTROL: an agent with no transport still gets the backstop', () => {
        // Without this, "the backstop did not fire" below would pass against a
        // scenario that never reached the deadline at all.
        const pty = runToBackstop(false);
        const texts = pty.mock.calls.map((c) => (c[0] as { text: string }).text);

        expect(texts.some((t) => /unread AgentInbox message/.test(t))).toBe(true);
    });

    it('an agent with a bound channel is never woken at its prompt', () => {
        const pty = runToBackstop(true);

        expect(pty).not.toHaveBeenCalled();
    });
});
