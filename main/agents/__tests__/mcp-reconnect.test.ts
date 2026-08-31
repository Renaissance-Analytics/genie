import { describe, expect, it, vi } from 'vitest';
import { announceAgentUpgrade } from '../upgrade-announcement';
import { mcpReconnectCommand } from '../mcp-reconnect';

/**
 * After Genie upgrades, an agent's `genie` MCP connection is STALE.
 *
 * The upgrade notice tells the agent to act — call `agentUpgrade`, follow the
 * migration guide — using tools whose connection died with the old process. So
 * the agent reads a nudge and then cannot do the thing the nudge asks for, which
 * looks like the tools are broken rather than merely disconnected.
 *
 * The reconnect therefore has to reach the terminal BEFORE the notice, not
 * alongside it and not as advice inside it: by the time an agent is reading
 * prose it has already tried and failed.
 *
 * The command is per-TUI. Claude Code takes `/mcp reconnect <server>`. Codex
 * does it differently and its entry is deliberately absent until its own agent
 * confirms the form — guessing a slash command for a harness that may not have
 * one would type junk into somebody's prompt.
 */
describe('mcpReconnectCommand', () => {
    it('gives Claude Code its slash command', () => {
        expect(mcpReconnectCommand('claude')).toBe('/mcp reconnect genie');
    });

    it('returns null for a TUI whose form is not known', () => {
        // Null means "send nothing". A guessed command is typed into a live
        // prompt, so being wrong here is worse than doing nothing.
        expect(mcpReconnectCommand('codex')).toBeNull();
        expect(mcpReconnectCommand('kiwi')).toBeNull();
        expect(mcpReconnectCommand('custom')).toBeNull();
    });

    it('returns null for a provider it has never heard of', () => {
        expect(mcpReconnectCommand('not-a-tui')).toBeNull();
    });
});

describe('the upgrade notice reconnects first', () => {
    const base = {
        currentVersion: '0.7.0-beta.286',
        previousVersion: '0.7.0-beta.285',
        changes: ['something'],
        persist: () => {},
    };

    it('reconnects BEFORE the notice is sent', () => {
        const order: string[] = [];
        announceAgentUpgrade({
            ...base,
            agentIds: ['a1'],
            reconnect: (id) => {
                order.push(`reconnect:${id}`);
            },
            send: (id) => {
                order.push(`send:${id}`);
                return true;
            },
        });
        // Order is the entire point: a notice that lands first is read with dead
        // tools.
        expect(order).toEqual(['reconnect:a1', 'send:a1']);
    });

    it('reconnects every agent it notifies', () => {
        const reconnected: string[] = [];
        announceAgentUpgrade({
            ...base,
            agentIds: ['a1', 'a2'],
            reconnect: (id) => reconnected.push(id),
            send: () => true,
        });
        expect(reconnected).toEqual(['a1', 'a2']);
    });

    it('still sends the notice when the reconnect throws', () => {
        // A failed reconnect leaves the agent worse informed, not silent. The
        // notice is the durable part and must not be lost to a TUI that would
        // not take the command.
        const send = vi.fn(() => true);
        announceAgentUpgrade({
            ...base,
            agentIds: ['a1'],
            reconnect: () => {
                throw new Error('pty gone');
            },
            send,
        });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('does nothing at all when the version has not moved', () => {
        // POSITIVE CONTROL on the guard: reconnecting every agent on every boot
        // would interrupt work for no reason.
        const reconnect = vi.fn();
        announceAgentUpgrade({
            ...base,
            previousVersion: base.currentVersion,
            agentIds: ['a1'],
            reconnect,
            send: () => true,
        });
        expect(reconnect).not.toHaveBeenCalled();
    });

    it('works without a reconnect callback at all', () => {
        // Callers that have no way to reach a terminal must not be forced to
        // invent one.
        const send = vi.fn(() => true);
        announceAgentUpgrade({ ...base, agentIds: ['a1'], send });
        expect(send).toHaveBeenCalledTimes(1);
    });
});
