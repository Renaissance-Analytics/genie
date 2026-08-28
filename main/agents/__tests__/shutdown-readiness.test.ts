import { describe, expect, it, vi } from 'vitest';
import { AgentShutdownReadiness } from '../shutdown-readiness';

describe('AMS shutdown readiness', () => {
    it('messages every running agent through AgentInbox and completes on shutdown thumbs-up', async () => {
        const send = vi.fn(() => true);
        const readiness = new AgentShutdownReadiness(send);
        const waiting = readiness.begin([
            { agentId: 'a', inboxAgentId: 'inbox-a', terminalId: 't-a' },
            { agentId: 'b', inboxAgentId: 'inbox-b', terminalId: 't-b' },
        ], 1_000);

        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledWith('inbox-a', expect.stringMatching(/shutdown/i));
        readiness.acknowledge('a', 'shutdown');
        readiness.acknowledge('b', 'boot');
        expect(readiness.pendingAgentIds()).toEqual(['b']);
        readiness.acknowledge('b', 'shutdown');

        await expect(waiting).resolves.toEqual({ ready: ['a', 'b'], timedOut: [] });
    });

    it('is bounded and reports agents that did not acknowledge', async () => {
        vi.useFakeTimers();
        try {
            const readiness = new AgentShutdownReadiness(() => true);
            const waiting = readiness.begin([
                { agentId: 'a', inboxAgentId: 'inbox-a', terminalId: 't-a' },
            ], 250);
            await vi.advanceTimersByTimeAsync(250);
            await expect(waiting).resolves.toEqual({ ready: [], timedOut: ['a'] });
        } finally {
            vi.useRealTimers();
        }
    });
});
