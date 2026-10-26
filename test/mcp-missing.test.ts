import { describe, expect, it } from 'vitest';
import { MCP_RECOVERY_SPACING_MS, McpRecovery, missingServers, mcpReportsFromMeta } from '../src/core/mcp-missing.js';

/**
 * AN AGENT THAT CAME UP WITHOUT A SERVER GENIE GAVE IT IS BROUGHT BACK (genie#1202). Measured after the owner's restart
 * into beta.44: 7 of 9 workspaces' agents had Tynn's instructions and NO Tynn tools — initialize answered, tools/list got a
 * Cloudflare 504 then a 429, and the CLI never asked again. prism-acp 0.27.0 reports each server under
 * `particle.academy/mcp_servers`; measured by the prism agent against the real CLIs: Claude says such a server is
 * `connected` with ZERO tools (so status alone never catches it), Codex says `failed`. Codex's startup updates carry no
 * tool count (`null` = unknown, never 0). There is no documented reconnect, so the recovery is a restart of the session on
 * the same conversation — spaced, and given up on in words, so a server that is really down never makes an agent loop.
 */

const T0 = Date.UTC(2026, 9, 26, 5, 0, 0);
const MIN = 60_000;

describe('which servers are missing', () => {
    it('Claude: connected with 0 tools is missing; connected with tools is not', () => {
        expect(missingServers([{ name: 'tynn', status: 'connected', toolCount: 0 }, { name: 'genie', status: 'connected', toolCount: 19 }], ['genie', 'tynn']))
            .toEqual([{ name: 'tynn', why: 'connected, but it listed no tools' }]);
    });

    it('Codex: failed is missing, with its error; null tool count is UNKNOWN, not missing', () => {
        expect(missingServers([{ name: 'tynn', status: 'failed', toolCount: null, error: 'MCP startup failed: 504' }, { name: 'genie', status: 'connected', toolCount: null }], ['genie', 'tynn']))
            .toEqual([{ name: 'tynn', why: 'failed: MCP startup failed: 504' }]);
    });

    it('pending is not missing yet; a server Genie does not manage is not its business', () => {
        expect(missingServers([{ name: 'tynn', status: 'pending', toolCount: null }, { name: 'gmail', status: 'failed', toolCount: 0 }], ['genie', 'tynn'])).toEqual([]);
    });

    it('reads prism-acp\'s report from a session update\'s _meta, and nothing from a shape it does not know', () => {
        const reports = [{ name: 'tynn', status: 'connected', toolCount: 0 }];
        expect(mcpReportsFromMeta({ 'particle.academy/mcp_servers': reports })).toEqual(reports);
        expect(mcpReportsFromMeta({ 'particle.academy/mcp_servers': [{ name: 7 }] })).toEqual([]);
        expect(mcpReportsFromMeta({})).toBeNull();
    });
});

describe('the recovery: restart on the same conversation, spaced, then given up on in words', () => {
    it('first time missing: restart; again within the spacing: wait; after it: restart once more; a third: give up', () => {
        const r = new McpRecovery();
        expect(r.decide('a1', T0)).toEqual({ action: 'restart', attempt: 1 });
        expect(r.decide('a1', T0 + MIN)).toEqual({ action: 'wait', untilMs: T0 + MCP_RECOVERY_SPACING_MS });
        expect(r.decide('a1', T0 + MCP_RECOVERY_SPACING_MS)).toEqual({ action: 'restart', attempt: 2 });
        expect(r.decide('a1', T0 + 3 * MCP_RECOVERY_SPACING_MS)).toEqual({ action: 'give-up', attempts: 2 });
        // Given up: said once, never again for that agent until it is healthy.
        expect(r.decide('a1', T0 + 9 * MCP_RECOVERY_SPACING_MS)).toEqual({ action: 'none' });
    });

    it('healthy again: the count starts over; another agent has its own count', () => {
        const r = new McpRecovery();
        r.decide('a1', T0);
        r.healthy('a1');
        expect(r.decide('a1', T0 + MIN)).toEqual({ action: 'restart', attempt: 1 });
        expect(r.decide('a2', T0 + MIN)).toEqual({ action: 'restart', attempt: 1 });
    });
});
