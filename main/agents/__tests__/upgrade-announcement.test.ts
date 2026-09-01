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
            agents: [
                { agentId: 'a-tynn', name: 'tynn-builder' },
                { agentId: 'a-front', name: 'frontend' },
            ],
            changes: ['Native inbox delivery'],
            send,
            persist,
        })).toBe(2);

        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenNthCalledWith(1, 'a-tynn', expect.stringContaining('no reply is needed'));
        expect(send).toHaveBeenNthCalledWith(2, 'a-front', expect.stringContaining('no reply is needed'));
        expect(persist).toHaveBeenCalledWith('0.8.0');
    });

    it('does nothing when this version was already announced', () => {
        const send = vi.fn(() => true);
        const persist = vi.fn();
        expect(announceAgentUpgrade({
            currentVersion: '0.8.0',
            previousVersion: '0.8.0',
            agents: [{ agentId: 'a-tynn', name: 'tynn-builder' }],
            changes: [],
            send,
            persist,
        })).toBe(0);
        expect(send).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
    });
});

/**
 * An agent named `general` is NEVER nudged (Tynn story #262).
 *
 * The owner's rule: *"No agents named general get any nudges or anything so
 * they don't start doing work on restart if any still exist."*
 *
 * v62 removes the DORMANT `general` agents, but three on this workstation hold
 * a live terminal and are deliberately left alone. Those survivors must not be
 * woken by the upgrade announcement — a nudge lands in a TUI and starts a turn,
 * which is precisely what must not happen to an agent nobody meant to create.
 *
 * The RECONNECT is covered too, not just the message. It types a command into
 * the agent's terminal, so a reconnect without a notice is still a nudge — and
 * it runs FIRST, so excluding only the message would wake the agent anyway.
 */
describe('an agent named `general` is never nudged', () => {
    const base = {
        currentVersion: '0.8.0',
        previousVersion: '0.7.9',
        changes: ['Native inbox delivery'],
    };

    it('is not sent the upgrade notice', () => {
        const send = vi.fn(() => true);
        const persist = vi.fn();

        const sent = announceAgentUpgrade({
            ...base,
            agents: [
                { agentId: 'a-general', name: 'general' },
                { agentId: 'a-real', name: 'frontend' },
            ],
            send,
            persist,
        });

        expect(sent).toBe(1);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith('a-real', expect.any(String));
    });

    it('is not RECONNECTED either — that types into its terminal', () => {
        const reconnect = vi.fn();

        announceAgentUpgrade({
            ...base,
            agents: [
                { agentId: 'a-general', name: 'general' },
                { agentId: 'a-real', name: 'frontend' },
            ],
            send: () => true,
            reconnect,
            persist: vi.fn(),
        });

        expect(reconnect).toHaveBeenCalledTimes(1);
        expect(reconnect).toHaveBeenCalledWith('a-real');
    });

    it('still records the version when every agent was skipped', () => {
        // Otherwise a workstation whose only agents are `general` would re-run
        // the announcement on every single boot, forever.
        const persist = vi.fn();

        const sent = announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a-general', name: 'general' }],
            send: () => true,
            persist,
        });

        expect(sent).toBe(0);
        expect(persist).toHaveBeenCalledWith('0.8.0');
    });

    it('matches the WHOLE name — `general-purpose` is a real agent and IS nudged', () => {
        const send = vi.fn(() => true);

        announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a-gp', name: 'general-purpose' }],
            send,
            persist: vi.fn(),
        });

        expect(send).toHaveBeenCalledWith('a-gp', expect.any(String));
    });
});
