import { describe, expect, it } from 'vitest';
import {
    agentMcpServers,
    codexServerNames,
    mcpConfigDrift,
    mcpRemovalGuard,
    mcpSourceForTui,
} from '../agent-mcp';

/**
 * "See and manage which MCP servers the agent gets" (Tynn #709).
 *
 * An agent's MCP set has been invisible from the UI since MCP shipped. That is
 * not a cosmetic gap: an afternoon went into an agent that looked healthy and
 * was toolless, because a change to `.mcp.json` does NOT reach a session that is
 * already running — Claude Code, Cursor and Codex all load their servers at
 * session start. Nothing said so, so nothing suggested a restart.
 *
 * Which file an agent reads depends on its TUI, so "the MCP servers" is a
 * question with three different answers on one workspace. Every assertion here
 * about a list is paired with an agent whose list is DIFFERENT — a reader that
 * always returned the same thing would pass a single-fixture test perfectly.
 */

const CLAUDE_CONFIG = {
    mcpServers: {
        genie: { type: 'http', url: 'http://127.0.0.1:8317/mcp/abc' },
        tynn: { type: 'http', url: 'https://tynn.ai/mcp/tynn' },
        playwright: { command: 'npx', args: ['@playwright/mcp'] },
    },
};

const CURSOR_CONFIG = {
    mcpServers: {
        genie: { url: 'http://127.0.0.1:8317/mcp/abc' },
    },
};

const CODEX_TOML = [
    '# BEGIN GENIE MCP: genie',
    '[mcp_servers.genie]',
    "url = 'http://127.0.0.1:8317/mcp/abc'",
    '# END GENIE MCP: genie',
    '',
    '[mcp_servers.fancy-ui]',
    "url = 'https://fancy.example/mcp'",
].join('\n');

describe('which config an agent actually reads', () => {
    it('routes each TUI to its own file', () => {
        expect(mcpSourceForTui('claude')).toBe('claude');
        expect(mcpSourceForTui('cursor')).toBe('cursor');
        expect(mcpSourceForTui('codex')).toBe('codex');
    });

    it('falls back to the Claude config for an agent with no TUI yet', () => {
        // A registered-but-never-started agent has `tui: null`. Showing nothing
        // would read as "this agent has no MCP servers", which is false.
        expect(mcpSourceForTui(null)).toBe('claude');
    });
});

describe('agentMcpServers', () => {
    const read = (tui: string | null) =>
        agentMcpServers({
            tui,
            claude: CLAUDE_CONFIG,
            cursor: CURSOR_CONFIG,
            codexToml: CODEX_TOML,
        });

    it('lists what a Claude agent gets', () => {
        expect(read('claude').map((s) => s.name)).toEqual(['genie', 'playwright', 'tynn']);
    });

    it('POSITIVE CONTROL: a Cursor agent on the same workspace gets a DIFFERENT list', () => {
        // Paired with the assertion above on purpose. A reader hard-wired to one
        // file, or one that merged all three, would pass the first test and fail
        // this one.
        expect(read('cursor').map((s) => s.name)).toEqual(['genie']);
    });

    it('POSITIVE CONTROL: a Codex agent reads its TOML, not the JSON', () => {
        expect(read('codex').map((s) => s.name)).toEqual(['fancy-ui', 'genie']);
    });

    it('says where each entry came from', () => {
        expect(read('codex').every((s) => s.source === 'codex')).toBe(true);
        expect(read('claude').every((s) => s.source === 'claude')).toBe(true);
    });

    it('shows how the agent reaches each server', () => {
        const byName = new Map(read('claude').map((s) => [s.name, s]));
        expect(byName.get('genie')?.detail).toBe('http://127.0.0.1:8317/mcp/abc');
        // A stdio server has no url; showing a blank cell would look like a bug.
        expect(byName.get('playwright')?.detail).toBe('npx @playwright/mcp');
    });

    it('marks the genie server REQUIRED and nothing else', () => {
        const claude = read('claude');
        expect(claude.find((s) => s.name === 'genie')?.required).toBe(true);
        expect(claude.find((s) => s.name === 'tynn')?.required).toBe(false);
        expect(claude.find((s) => s.name === 'playwright')?.required).toBe(false);
    });

    it('marks the servers Genie itself writes as managed', () => {
        // Removing one is not blocked, but it comes back on the next workspace
        // sync. Saying so beats the human doing it twice and filing a bug.
        const claude = read('claude');
        expect(claude.find((s) => s.name === 'tynn')?.managed).toBe(true);
        expect(claude.find((s) => s.name === 'playwright')?.managed).toBe(false);
    });

    it('is empty, not broken, when the config file does not exist', () => {
        expect(
            agentMcpServers({ tui: 'claude', claude: null, cursor: null, codexToml: '' }),
        ).toEqual([]);
    });

    it('survives a config a human broke', () => {
        // The file is editable by hand. A malformed one must not take the
        // surface down — the human needs the surface to fix it.
        expect(
            agentMcpServers({
                tui: 'claude',
                claude: { mcpServers: 'not an object' },
                cursor: null,
                codexToml: '',
            }),
        ).toEqual([]);
    });
});

describe('codexServerNames', () => {
    it('reads the section headers out of a TOML config', () => {
        expect(codexServerNames(CODEX_TOML)).toEqual(['genie', 'fancy-ui']);
    });

    it('ignores a section that merely mentions the table', () => {
        // A commented-out or nested key must not become a phantom server.
        expect(codexServerNames('# [mcp_servers.ghost]\n[other]\nx = 1\n')).toEqual([]);
    });

    it('reads a quoted section name', () => {
        expect(codexServerNames('[mcp_servers."my-server"]\nurl = \'x\'\n')).toEqual([
            'my-server',
        ]);
    });
});

describe('removing a server', () => {
    it('REFUSES to remove genie, and says why', () => {
        // Genie's own server is how the agent reports it is done, asks the human
        // a question, and reaches every host tool. An agent without it looks
        // healthy and is unreachable — the exact failure this surface exists to
        // stop, so it is blocked rather than warned about.
        const guard = mcpRemovalGuard('genie');
        expect(guard.allowed).toBe(false);
        expect(guard.allowed === false && guard.reason).toMatch(/genie/i);
        expect(guard.allowed === false && guard.reason.length).toBeGreaterThan(20);
    });

    it('POSITIVE CONTROL: allows removing an ordinary server', () => {
        // Otherwise a guard that refused everything would pass the test above.
        expect(mcpRemovalGuard('playwright').allowed).toBe(true);
        expect(mcpRemovalGuard('tynn').allowed).toBe(true);
    });

    it('refuses the AgentInbox channel too — it is the same lifeline', () => {
        expect(mcpRemovalGuard('genie-agentinbox-channel').allowed).toBe(false);
    });
});

describe('mcpConfigDrift', () => {
    // Only ever claims what it can PROVE. A session loads its MCP servers at
    // start, and `ready_at` is set at or after that start — so a config written
    // AFTER `ready_at` provably was not loaded. The converse does not follow
    // (the session may have started before the write and become ready after),
    // so there is no 'current' verdict to give and none is invented.
    it('has nothing to say about an agent that is not running', () => {
        expect(mcpConfigDrift({ running: false, readyAt: 1, configMtimeMs: 2 })).toBe(
            'not-running',
        );
    });

    it('proves staleness when the config was written after the agent was ready', () => {
        expect(mcpConfigDrift({ running: true, readyAt: 1_000, configMtimeMs: 2_000 })).toBe(
            'stale',
        );
    });

    it('will not claim staleness it cannot prove', () => {
        expect(mcpConfigDrift({ running: true, readyAt: 2_000, configMtimeMs: 1_000 })).toBe(
            'unproven',
        );
    });

    it('is unproven when the agent never reported ready', () => {
        expect(mcpConfigDrift({ running: true, readyAt: null, configMtimeMs: 2_000 })).toBe(
            'unproven',
        );
    });

    it('is unproven when there is no config file to date', () => {
        expect(mcpConfigDrift({ running: true, readyAt: 1_000, configMtimeMs: null })).toBe(
            'unproven',
        );
    });
});
