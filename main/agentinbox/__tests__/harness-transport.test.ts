import { describe, expect, it, vi } from 'vitest';
import {
    completeTransportHandshake,
    HarnessTransportRegistry,
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
