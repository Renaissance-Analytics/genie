import { describe, expect, it } from 'vitest';
import { reconnectStrategy, recoveryInstruction } from '../mcp-reconnect';
import { formatAgentUpgradeMessage } from '../upgrade-announcement';
import {
    AGENTINBOX_CLAUDE_CHANNEL_NAME,
    GENIE_ENDPOINT_SERVERS,
    GENIE_SERVER_NAME,
} from '../../mcp/genie-servers';

/**
 * AN UPGRADE THE SHUTTLE CARRIED (genie#346).
 *
 * With agents served through the shuttle, a new Genie that finds the shuttle
 * still running ATTACHES to it: the process behind every agent's endpoint was
 * never replaced, and their `genie` connections were kept. Everything the
 * upgrade notice used to do assumed the opposite:
 *
 *  - Claude agents had `/mcp reconnect genie` typed at their prompt — repairing
 *    a connection that was fine, with Genie's ONE typed command per upgrade;
 *  - Codex agents were RESTARTED;
 *  - the notice said "The upgrade replaced the process behind Genie's MCP
 *    endpoint", which was no longer true.
 *
 * What CAN still be down is the AgentInbox channel bridge (a separate stdio
 * process — killed by the updater while it ran on Genie.exe). So a kept endpoint
 * spends the one typed command on the channel, and only when that agent's
 * channel has not re-registered.
 */
describe('reconnectStrategy when the endpoint was kept', () => {
    it('does NOTHING to a Claude agent whose channel is back — both connections are up', () => {
        const strategy = reconnectStrategy('claude', { endpointKept: true, channelBound: true });
        expect(strategy.kind).toBe('kept');
        expect(strategy.kept).toEqual(GENIE_ENDPOINT_SERVERS.claude);
        expect(strategy.restores).toEqual([]);
        expect(recoveryInstruction({ strategy, applied: true })).toBe('');
    });

    it('reconnects the CHANNEL — not `genie` — when that agent\'s channel is still down', () => {
        const strategy = reconnectStrategy('claude', { endpointKept: true, channelBound: false });
        expect(strategy.kind).toBe('command');
        expect(strategy.kind === 'command' && strategy.text).toBe(`/mcp reconnect ${AGENTINBOX_CLAUDE_CHANNEL_NAME}`);
        expect(strategy.restores).toEqual([AGENTINBOX_CLAUDE_CHANNEL_NAME]);
        expect(strategy.kept).toEqual([GENIE_SERVER_NAME]);

        // Nothing left for a person: `genie` was kept and the channel was the one
        // the command repaired, so no "a person has to run …" clause.
        const ran = recoveryInstruction({ strategy, applied: true });
        expect(ran).toContain(`/mcp reconnect ${AGENTINBOX_CLAUDE_CHANNEL_NAME}`);
        expect(ran).not.toMatch(/person has to run/);
        expect(ran).not.toMatch(/\/mcp reconnect genie`/);
    });

    it('does not RESTART a Codex agent whose connection was kept', () => {
        const strategy = reconnectStrategy('codex', { endpointKept: true, channelBound: false });
        expect(strategy.kind).toBe('kept');
        expect(strategy.kept).toEqual(GENIE_ENDPOINT_SERVERS.codex);
    });

    it('POSITIVE CONTROL: an endpoint that was replaced still gets today\'s repairs', () => {
        expect(reconnectStrategy('claude', { endpointKept: false, channelBound: true })).toMatchObject({
            kind: 'command',
            text: `/mcp reconnect ${GENIE_SERVER_NAME}`,
        });
        expect(reconnectStrategy('codex', { endpointKept: false }).kind).toBe('restart');
        // …and the no-context call is exactly that path, for every existing caller.
        expect(reconnectStrategy('claude')).toMatchObject({ kind: 'command', text: `/mcp reconnect ${GENIE_SERVER_NAME}` });
    });
});

describe('the upgrade notice when the endpoint was kept', () => {
    it('says the connection was kept, instead of claiming the process behind it was replaced', () => {
        const strategy = reconnectStrategy('claude', { endpointKept: true, channelBound: true });
        const message = formatAgentUpgradeMessage('0.7.0-beta.325', ['a change'], { strategy, applied: true }, 'manual', 'attached');
        expect(message).not.toMatch(/replaced the process/);
        expect(message).toMatch(/kept/);
        // Never tells the agent to reconnect something that is up.
        expect(message).not.toMatch(/\/mcp reconnect/);
    });

    it('POSITIVE CONTROL: a replaced endpoint still says so', () => {
        const strategy = reconnectStrategy('claude');
        const message = formatAgentUpgradeMessage('0.7.0-beta.325', [], { strategy, applied: true }, 'manual', 'unknown');
        expect(message).toMatch(/replaced the process/);
    });
});
