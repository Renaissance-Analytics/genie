import { describe, expect, it, vi } from 'vitest';
import {
    completeTransportHandshake,
    HarnessTransportRegistry,
    PULL_LIVENESS_GRACE_MS,
    requiredHarnessTransport,
} from '../harness-transport';

describe('AMS harness-native transport registry', () => {
    it('maps only providers with implemented native adapters', () => {
        expect(requiredHarnessTransport('claude')).toBe('claude-channel');
        expect(requiredHarnessTransport('codex')).toBe('codex-app-server');
        expect(requiredHarnessTransport('kilo')).toBeNull();
        expect(requiredHarnessTransport('genie')).toBeNull();
        expect(requiredHarnessTransport('custom')).toBeNull();
    });

    it('does not replace a live adapter while confirming its transport', async () => {
        const originalSend = vi.fn(async () => undefined);
        const registry = new HarnessTransportRegistry();
        registry.bind('agent-1', 'codex-app-server', originalSend);

        expect(registry.confirm('agent-1', 'codex-app-server')).toBe(true);
        await registry.deliver('agent-1', { text: 'still live' });

        expect(originalSend).toHaveBeenCalledWith({ text: 'still live' });
    });

    it('queues when no verified native session is bound and never accepts a fallback', () => {
        const registry = new HarnessTransportRegistry();
        expect(registry.deliver('agent-1', { text: 'hello' })).toEqual({
            ok: false,
            queued: true,
            error: 'Harness transport is not verified.',
        });
    });

    it('delivers through the verified native session', async () => {
        const send = vi.fn(async () => undefined);
        const registry = new HarnessTransportRegistry();
        registry.bind('agent-1', 'claude-channel', send);

        await expect(registry.deliver('agent-1', { text: 'hello' })).resolves.toEqual({
            ok: true,
            queued: false,
        });
        expect(send).toHaveBeenCalledWith({ text: 'hello' });
    });

    it('tells a PULL binding apart from a PUSH one', () => {
        const registry = new HarnessTransportRegistry();
        registry.bind('codex-agent', 'codex-app-server', async () => undefined);
        registry.bindPull('claude-agent', 'claude-channel');

        // Both are LIVE — the difference is who moves the message, not whether
        // the harness is there.
        expect(registry.deliveryModeFor('codex-agent')).toBe('push');
        expect(registry.deliveryModeFor('claude-agent')).toBe('pull');
        expect(registry.deliveryModeFor('nobody')).toBeNull();

        expect(registry.kindFor('claude-agent')).toBe('claude-channel');
        expect(registry.isVerified('claude-agent', 'claude-channel')).toBe(true);
        expect(registry.confirm('claude-agent', 'claude-channel')).toBe(true);
    });

    it('never claims to have pushed down a pull binding, and keeps it bound', () => {
        // A pull transport has no sender: the Claude Channel bridge holds a
        // blocking `receive` and takes its own mail. Answering `ok` here would
        // ACK a message nothing had delivered.
        const registry = new HarnessTransportRegistry();
        registry.bindPull('claude-agent', 'claude-channel');

        expect(registry.deliver('claude-agent', { text: 'hello' })).toEqual({
            ok: false,
            queued: true,
            error: 'This harness pulls from the durable inbox; there is nothing to push to.',
        });
        // ...and the failed push must NOT unbind it — the channel is still live.
        expect(registry.deliveryModeFor('claude-agent')).toBe('pull');
    });

    it('releases a pull binding when its holder is gone, and leaves push bindings alone', () => {
        // Push bindings self-heal: a send that throws unbinds them (below).
        // Nothing ever calls into a pull binding, so a stale one would swallow
        // every message AND suppress the PTY fallback forever. It is released
        // when the process holding it goes away.
        const registry = new HarnessTransportRegistry();
        registry.bindPull('claude-agent', 'claude-channel');
        registry.bind('codex-agent', 'codex-app-server', async () => undefined);

        registry.unbindPull('claude-agent');
        registry.unbindPull('codex-agent');

        expect(registry.deliveryModeFor('claude-agent')).toBeNull();
        expect(registry.deliveryModeFor('codex-agent')).toBe('push');
    });

    it('unbinds a failed session so later messages remain durable and queued', async () => {
        const registry = new HarnessTransportRegistry();
        registry.bind('agent-1', 'codex-app-server', async () => {
            throw new Error('connection closed');
        });

        await expect(registry.deliver('agent-1', { text: 'hello' })).resolves.toMatchObject({
            ok: false,
            queued: true,
            error: 'connection closed',
        });
        expect(registry.isVerified('agent-1')).toBe(false);
    });
});

/**
 * The `registerTransport` handshake — what a harness saying "I am connected"
 * actually leaves behind.
 *
 * genie#344: for Claude it left NOTHING. The handler recorded the DB state and
 * returned ok, but no binding existed, so every later question about whether
 * that agent had a live channel answered "no" — and AgentInbox typed its notices
 * into that agent's terminal instead.
 */
describe('the registerTransport handshake', () => {
    it('binds a Claude Channel as a live PULL transport', () => {
        // The bridge reaches this call only after answering `initialize`, and
        // parks its blocking `receive` immediately after. The handshake IS the
        // evidence the channel is up — there is nothing else to wait for.
        const registry = new HarnessTransportRegistry();

        expect(completeTransportHandshake(registry, 'claude-agent', 'claude-channel')).toEqual({
            ok: true,
        });
        expect(registry.deliveryModeFor('claude-agent')).toBe('pull');
        expect(registry.kindFor('claude-agent')).toBe('claude-channel');
    });

    it('confirms a Codex app-server binding but never mints one', () => {
        // Codex is connected by the app-server adapter in terminal/ipc. An agent
        // handshake may confirm that binding; minting one the adapter never made
        // would route mail into a session that does not exist.
        const registry = new HarnessTransportRegistry();

        expect(completeTransportHandshake(registry, 'codex-agent', 'codex-app-server')).toEqual({
            ok: false,
            error: 'The Codex app-server adapter is not connected.',
        });
        expect(registry.deliveryModeFor('codex-agent')).toBeNull();

        registry.bind('codex-agent', 'codex-app-server', vi.fn(async () => undefined));
        expect(completeTransportHandshake(registry, 'codex-agent', 'codex-app-server')).toEqual({
            ok: true,
        });
        // ...and confirming did not turn the live sender into a pull binding.
        expect(registry.deliveryModeFor('codex-agent')).toBe('push');
    });

    it('re-handshakes a reconnected channel in place', () => {
        // A relaunched bridge registers again under the same durable agent id.
        // One release must then be enough to clear it.
        const registry = new HarnessTransportRegistry();
        completeTransportHandshake(registry, 'claude-agent', 'claude-channel');
        completeTransportHandshake(registry, 'claude-agent', 'claude-channel');

        registry.unbindPull('claude-agent');
        expect(registry.deliveryModeFor('claude-agent')).toBeNull();
    });
});

/**
 * Whether a PULL binding has PROVEN itself alive — genie#528.
 *
 * The two release paths (`ipc.ts` pty-exit and terminal-kill) only fire when the
 * terminal goes. The Claude Channel bridge can stop while its pty lives on: a
 * 401/403 sets `process.exitCode` and `run()` returns, and Claude Code closing
 * the bridge's stdin sets `stopped` and ends the loop. Genie is told neither, so
 * the binding outlived its holder and `harnessAttached` stayed true — mail was
 * handed to a pull binding nothing was listening to, with the PTY fallback held
 * shut behind it.
 *
 * The fix is not another release caller. It is that the binding must EARN the
 * answer: liveness is evidence, not a mint that never expires.
 *
 * The hard part, and the reason a "last completed receive" deadline is wrong:
 * **a parked long-poll is alive and silent.** The bridge polls for 240s at a
 * time, so a healthy channel produces no traffic at all for minutes. Evidence
 * therefore comes from a poll being OPEN — an in-flight `receive` is the bridge
 * holding an HTTP request against us, which is proof by itself — and the
 * deadline applies only to the gap BETWEEN polls.
 *
 * The check is deliberately ASYMMETRIC. Unproven liveness means "fall back to
 * the PTY", never "suppress delivery": a duplicate line costs the user nothing,
 * a swallowed message costs them the work.
 */
describe('a pull binding must prove it is still alive (genie#528)', () => {
    /** A registry on a clock we control. */
    function atTime(start = 1_000_000): {
        registry: HarnessTransportRegistry;
        advance: (ms: number) => void;
    } {
        let now = start;
        const registry = new HarnessTransportRegistry(() => now);
        return {
            registry,
            advance: (ms) => {
                now += ms;
            },
        };
    }

    it('goes dead once nothing has polled for it', () => {
        // THE BUG, in the fewest moving parts that can show it: a binding is
        // minted by the handshake and then NOTHING happens. Before the fix this
        // stayed verified forever, which is what let a dead bridge swallow every
        // message with the PTY fallback held shut behind it.
        const { registry, advance } = atTime();
        registry.bindPull('claude-agent', 'claude-channel');

        advance(PULL_LIVENESS_GRACE_MS + 1);

        expect(registry.isVerified('claude-agent')).toBe(false);
        expect(registry.isVerified('claude-agent', 'claude-channel')).toBe(false);
        expect(registry.deliveryModeFor('claude-agent')).toBeNull();
        expect(registry.kindFor('claude-agent')).toBeNull();
    });

    it('ages out after a poll that COMPLETED and was never followed by another', () => {
        // The shape both real triggers leave behind. A 401/403 throws out of the
        // `receive` that had just returned, and a closed stdin ends the loop
        // after the current poll settles — in each case the last poll completed
        // cleanly and no successor ever opened.
        const { registry, advance } = atTime();
        registry.bindPull('claude-agent', 'claude-channel');
        registry.notePullPollOpen('claude-agent');
        advance(240_000);
        registry.notePullPollClosed('claude-agent');

        advance(PULL_LIVENESS_GRACE_MS + 1);

        expect(registry.isVerified('claude-agent')).toBe(false);
        expect(registry.deliveryModeFor('claude-agent')).toBeNull();
    });

    it('POSITIVE CONTROL: a long-poll parked for minutes is alive, not stale', () => {
        // The whole difficulty. The bridge parks a 240s `receive` and says
        // NOTHING while it waits. A deadline measured from the last COMPLETED
        // poll would unbind this perfectly healthy channel at second 241 and
        // start typing its mail at the prompt — turning a rare bug into a
        // routine one. An open poll is proof of life on its own.
        const { registry, advance } = atTime();
        registry.bindPull('claude-agent', 'claude-channel');
        registry.notePullPollOpen('claude-agent');

        advance(PULL_LIVENESS_GRACE_MS * 100);

        expect(registry.isVerified('claude-agent')).toBe(true);
        expect(registry.deliveryModeFor('claude-agent')).toBe('pull');
        expect(registry.kindFor('claude-agent')).toBe('claude-channel');
    });

    it('POSITIVE CONTROL: a binding is live from the handshake, before any poll', () => {
        // `registerTransport` lands the binding BEFORE the bridge parks its
        // first `receive`. Requiring a poll to have happened would read every
        // freshly-connected channel as dead — including the OS agent's, whose
        // `thumbsUp(reason:'boot')` is gated on this very answer.
        const { registry } = atTime();
        completeTransportHandshake(registry, 'claude-agent', 'claude-channel');

        expect(registry.isVerified('claude-agent', 'claude-channel')).toBe(true);
        expect(registry.deliveryModeFor('claude-agent')).toBe('pull');
    });

    it('POSITIVE CONTROL: stays live across the gap between two polls', () => {
        // The bridge closes a poll and immediately opens the next one. That gap
        // is milliseconds in the normal case and at most one reconnect backoff
        // when it is not; neither may read as death.
        const { registry, advance } = atTime();
        registry.bindPull('claude-agent', 'claude-channel');

        for (let cycle = 0; cycle < 5; cycle++) {
            registry.notePullPollOpen('claude-agent');
            advance(240_000); // a full poll, parked
            expect(registry.isVerified('claude-agent')).toBe(true);
            registry.notePullPollClosed('claude-agent');
            advance(50); // write the notification, ACK it, re-poll
            expect(registry.isVerified('claude-agent')).toBe(true);
        }
    });

    it('comes back to life when the bridge polls again', () => {
        // Reported dead, NOT deleted. A bridge that was merely slow recovers on
        // its next poll instead of needing a fresh handshake — and a relaunched
        // one re-mints the binding through `registerTransport` anyway.
        const { registry, advance } = atTime();
        registry.bindPull('claude-agent', 'claude-channel');
        advance(PULL_LIVENESS_GRACE_MS + 1);
        expect(registry.isVerified('claude-agent')).toBe(false);

        registry.notePullPollOpen('claude-agent');

        expect(registry.isVerified('claude-agent')).toBe(true);
        expect(registry.deliveryModeFor('claude-agent')).toBe('pull');
    });

    it('counts overlapping polls, so superseding one does not read as death', () => {
        // `broker.receive` supersedes an existing waiter rather than refusing,
        // so a second poll can open before the first settles. Closing the
        // superseded one must not retire a binding the newer poll still holds.
        const { registry, advance } = atTime();
        registry.bindPull('claude-agent', 'claude-channel');
        registry.notePullPollOpen('claude-agent');
        registry.notePullPollOpen('claude-agent');

        registry.notePullPollClosed('claude-agent');
        advance(PULL_LIVENESS_GRACE_MS * 10);

        expect(registry.isVerified('claude-agent')).toBe(true);
    });

    it('never applies the deadline to a PUSH binding', () => {
        // Codex owns its own lifecycle: a send that throws unbinds it, so it
        // self-heals into the PTY fallback on the next message. It is silent
        // between turns by design and has no poll to prove anything with —
        // ageing it out would unbind a live App Server session.
        const { registry, advance } = atTime();
        const send = vi.fn(async () => undefined);
        registry.bind('codex-agent', 'codex-app-server', send);

        advance(PULL_LIVENESS_GRACE_MS * 1000);

        expect(registry.isVerified('codex-agent', 'codex-app-server')).toBe(true);
        expect(registry.deliveryModeFor('codex-agent')).toBe('push');
    });

    it('ignores poll bookkeeping for a push binding or an unknown agent', () => {
        // The `receive` call site cannot know which kind of binding the caller
        // holds, so both calls must be no-ops off the pull path rather than
        // minting or mutating anything.
        const { registry } = atTime();
        registry.bind('codex-agent', 'codex-app-server', vi.fn(async () => undefined));

        registry.notePullPollOpen('codex-agent');
        registry.notePullPollClosed('codex-agent');
        registry.notePullPollOpen('nobody');
        registry.notePullPollClosed('nobody');

        expect(registry.deliveryModeFor('codex-agent')).toBe('push');
        expect(registry.deliveryModeFor('nobody')).toBeNull();
        expect(registry.isVerified('nobody')).toBe(false);
    });

    it('stops pushing down a binding that has gone stale', () => {
        // `deliver` must read the same liveness the sink does, or a stale
        // binding would still answer "there is nothing to push to" — the reply
        // that means "attached, hold the keyboard".
        const { registry, advance } = atTime();
        registry.bindPull('claude-agent', 'claude-channel');
        advance(PULL_LIVENESS_GRACE_MS + 1);

        expect(registry.deliver('claude-agent', { text: 'hello' })).toEqual({
            ok: false,
            queued: true,
            error: 'Harness transport is not verified.',
        });
    });
});
