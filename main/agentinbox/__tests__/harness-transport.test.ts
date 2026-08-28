import { describe, expect, it, vi } from 'vitest';
import {
    HarnessTransportRegistry,
    requiredHarnessTransport,
} from '../harness-transport';

describe('AMS harness-native transport registry', () => {
    it('maps Claude and Codex to their native transports', () => {
        expect(requiredHarnessTransport('claude')).toBe('claude-channel');
        expect(requiredHarnessTransport('codex')).toBe('codex-app-server');
        expect(requiredHarnessTransport('custom')).toBeNull();
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
