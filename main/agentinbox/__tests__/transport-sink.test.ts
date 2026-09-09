import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInboxBroker } from '../broker';
import { HarnessTransportRegistry, PULL_LIVENESS_GRACE_MS } from '../harness-transport';
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
 * The OTHER door onto the same keyboard — and the one #344 shut too far.
 *
 * Fixing the sink stops the delivery-time notice. The unread DEADLINE is a
 * different question, and this block used to answer it the same way: an agent
 * with a channel bound was never woken, full stop, on the reasoning that its
 * mail was its channel's to deliver.
 *
 * That reasoning fails whenever the channel delivers nothing — a state Genie
 * cannot see and Claude Code enters silently, and the one with no other way out
 * (genie#549). The deadline now asks whether the mail was READ; that contract
 * lives in `backstop-unread.test.ts`. What stays here is the part a binding
 * really does support: no SECOND copy typed the instant a message arrives.
 */
describe('a bound transport keeps the DELIVERY-TIME notice off the keyboard', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    /** Deliver one message, with or without a live channel bound. */
    function deliverOne(bind: boolean): ReturnType<typeof vi.fn> {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { broker, registry, pty } = wired();
        if (bind) {
            registry.bindPull('B', 'claude-channel');
            // Parked on its long-poll, which is what a live bridge is doing for
            // the whole of this scenario. Without it the binding would be
            // trusted only for as long as `PULL_LIVENESS_GRACE_MS` (genie#528),
            // and this test would pass or fail on whether that constant happens
            // to exceed the window below — a coupling nothing here declares.
            registry.notePullPollOpen('B');
        }

        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'unread mail' });
        // Well short of NUDGE_UNCHECKED_MS: the only thing that can have reached
        // the keyboard by now is the arrival notice.
        vi.advanceTimersByTime(50_000);
        return pty;
    }

    it('POSITIVE CONTROL: an unattached agent IS told the moment mail lands', () => {
        // Without this, "nothing was typed" below would pass against a broker
        // that never types at all.
        const pty = deliverOne(false);
        const texts = pty.mock.calls.map((c) => (c[0] as { text: string }).text);

        expect(texts.some((t) => /You just received a message/.test(t))).toBe(true);
    });

    it('an agent with a bound channel is not told twice', () => {
        const pty = deliverOne(true);

        expect(pty).not.toHaveBeenCalled();
    });
});

/**
 * The keyboard comes BACK when a channel stops proving it is alive — genie#528.
 *
 * `unbindPull` is called on pty exit and on terminal kill, which covers the
 * common case. It cannot cover the one that matters here: the Claude Channel
 * bridge is spawned by Claude Code, not by Genie, so it can stop while its pty
 * runs on — a 401/403 sets `process.exitCode` and its supervisor returns, and a
 * closed stdin ends its loop. Genie is told neither.
 *
 * So the binding has to expire on evidence instead. These two tests are the
 * whole contract, and they pull in opposite directions on purpose: a channel
 * that has gone quiet must give the keyboard back, and a channel merely PARKED
 * on its long-poll — silent for minutes at a time, by design — must not.
 */
describe('a pull binding that stops proving itself gives the PTY back (genie#528)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('delivers over the PTY once the channel has gone quiet', () => {
        // Nothing releases this binding: no pty exited, no terminal was killed.
        // Before the fix it stayed attached forever and this message reached
        // NOBODY — swallowed by a pull binding with the fallback held shut.
        vi.useFakeTimers();
        const { broker, registry, pty } = wired();
        registry.bindPull('B', 'claude-channel');
        registry.notePullPollOpen('B');
        registry.notePullPollClosed('B'); // its last poll returned; none followed

        vi.advanceTimersByTime(PULL_LIVENESS_GRACE_MS + 1);
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'this must still land' });

        expect(pty).toHaveBeenCalledTimes(1);
        expect(pty.mock.calls[0]![0]).toMatchObject({ terminalId: 't-B' });
    });

    it('POSITIVE CONTROL: a channel parked on its long-poll keeps the keyboard shut', () => {
        // The failure this fix must not cause. A healthy bridge holds a 240s
        // `receive` open and says nothing at all while it waits; if that read as
        // death, Genie would type into a perfectly good channel every few
        // minutes — a rare bug traded for a routine one.
        vi.useFakeTimers();
        const { broker, registry, pty } = wired();
        registry.bindPull('B', 'claude-channel');
        registry.notePullPollOpen('B');

        vi.advanceTimersByTime(PULL_LIVENESS_GRACE_MS * 10);
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'the channel has this' });

        expect(pty).not.toHaveBeenCalled();
    });
});
