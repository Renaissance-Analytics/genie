import { describe, expect, it, vi } from 'vitest';
import { announceAgentUpgrade, formatAgentUpgradeMessage } from '../upgrade-announcement';

describe('agent upgrade announcement', () => {
    it('formats a concise no-reply system message', () => {
        expect(formatAgentUpgradeMessage('0.8.0', ['Native AgentInbox transport', 'What’s New menu'])).toBe(
            'Genie upgraded to v0.8.0. What changed:\n- Native AgentInbox transport\n- What’s New menu\n\nIf this terminal predates AMS, call agentUpgrade now and follow its ordered migration guide.\n\nThis is a system notice; no reply is needed.',
        );
    });

    it('sends once to every registered agent after a version change', () => {
        const send = vi.fn(() => true);
        const persist = vi.fn();

        expect(announceAgentUpgrade({
            currentVersion: '0.8.0',
            previousVersion: '0.7.9',
            agentIds: ['claude:tynn', 'codex:genie'],
            changes: ['Native inbox delivery'],
            send,
            persist,
        })).toBe(2);

        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenNthCalledWith(1, 'claude:tynn', expect.stringContaining('no reply is needed'));
        expect(send).toHaveBeenNthCalledWith(2, 'codex:genie', expect.stringContaining('no reply is needed'));
        expect(persist).toHaveBeenCalledWith('0.8.0');
    });

    it('does nothing when this version was already announced', () => {
        const send = vi.fn(() => true);
        const persist = vi.fn();
        expect(announceAgentUpgrade({
            currentVersion: '0.8.0',
            previousVersion: '0.8.0',
            agentIds: ['claude:tynn'],
            changes: [],
            send,
            persist,
        })).toBe(0);
        expect(send).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
    });
});
