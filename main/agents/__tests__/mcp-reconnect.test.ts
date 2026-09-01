import { describe, expect, it, vi } from 'vitest';
import { announceAgentUpgrade } from '../upgrade-announcement';
import { mcpReconnectCommand, reconnectStrategy } from '../mcp-reconnect';

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
 * The repair is per-TUI, and not a matter of taste. Claude Code takes
 * `/mcp reconnect genie`, typed. Codex has NO equivalent — verified by the
 * Codex agent against codex-cli 0.150.1 — and does not discover the
 * replacement URL either, because Genie passes it in launch config. Its repair
 * is a managed RESTART, which resumes the session against refreshed config.
 *
 * Anything else does nothing: a guessed slash command is typed into a live
 * prompt that may be a modal, and on Codex's update picker option 1 runs a
 * global npm install.
 */
describe('mcpReconnectCommand', () => {
    it('gives Claude Code its slash command', () => {
        expect(mcpReconnectCommand('claude')).toBe('/mcp reconnect genie');
    });

    it('gives Codex a RESTART, never typed text', () => {
        // Verified by the Codex agent against codex-cli 0.150.1: `codex mcp`
        // exposes only list/get/add/remove/login/logout — there is no
        // single-server reconnect. And Codex does not discover the replacement
        // URL, because Genie passes it in launch config, so the running process
        // keeps the old endpoint. A managed restart resumes the session against
        // refreshed config.
        expect(reconnectStrategy('codex')).toEqual({ kind: 'restart' });
        expect(mcpReconnectCommand('codex')).toBeNull();
    });

    it('does NOTHING for a TUI whose form is unknown', () => {
        // A guessed command is typed into a live prompt. Codex parks on
        // key-driven modals — update pickers, approval requests, trust prompts —
        // where injected text is read as an answer, and on the update picker
        // option 1 runs a global npm install.
        expect(reconnectStrategy('kiwi')).toEqual({ kind: 'none' });
        expect(reconnectStrategy('custom')).toEqual({ kind: 'none' });
        expect(mcpReconnectCommand('kiwi')).toBeNull();
    });

    it('returns null for a provider it has never heard of', () => {
        expect(reconnectStrategy('not-a-tui')).toEqual({ kind: 'none' });
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
            agents: [{ agentId: 'a1', name: 'alpha' }],
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
            agents: [{ agentId: 'a1', name: 'alpha' }, { agentId: 'a2', name: 'beta' }],
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
            agents: [{ agentId: 'a1', name: 'alpha' }],
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
            agents: [{ agentId: 'a1', name: 'alpha' }],
            reconnect,
            send: () => true,
        });
        expect(reconnect).not.toHaveBeenCalled();
    });

    it('works without a reconnect callback at all', () => {
        // Callers that have no way to reach a terminal must not be forced to
        // invent one.
        const send = vi.fn(() => true);
        announceAgentUpgrade({ ...base, agents: [{ agentId: 'a1', name: 'alpha' }], send });
        expect(send).toHaveBeenCalledTimes(1);
    });
});
