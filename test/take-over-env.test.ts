import { describe, expect, it } from 'vitest';
import { claudeMcpConfig, codexMcpConfig, mintMcpToken, takeOverEnv } from '../src/core/take-over-env.js';

/**
 * THE TAKE OVER ENVIRONMENT CONTRACT (§1, §6.9) — three variables in every terminal Genie opens for
 * a TUI: `GENIE_MCP_URL`, `GENIE_TERMINAL_ID`, `GENIE_MCP_TOKEN`. The token is a per-process bearer
 * (prism-mcp-server checks it in constant time) and travels as a VARIABLE, never in the URL — URLs
 * get logged and shown in a TUI's /mcp listing. The TUI's MCP config REFERENCES the variable
 * (Claude Code `${GENIE_MCP_TOKEN}`, Codex `bearer_token_env_var`) so the literal token never lands
 * in a file. Until the VM measures both TUIs honouring that, the contract says exactly that and no
 * more.
 */

describe('the token', () => {
    it('is minted per process, 32 bytes of randomness as url-safe base64, and never the same twice', () => {
        const a = mintMcpToken();
        const b = mintMcpToken();
        expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(a).not.toBe(b);
    });
});

describe('the environment', () => {
    it('carries exactly the three variables, the token as a variable and never inside the URL', () => {
        const env = takeOverEnv({ mcpUrl: 'http://127.0.0.1:4242/mcp', terminalId: 'term_1', token: 'tok' });
        expect(env).toEqual({ GENIE_MCP_URL: 'http://127.0.0.1:4242/mcp', GENIE_TERMINAL_ID: 'term_1', GENIE_MCP_TOKEN: 'tok' });
        expect(env.GENIE_MCP_URL).not.toContain('tok');
    });

    it('refuses an empty token, a non-loopback URL, or an empty terminal id — an open server is worse than no server', () => {
        expect(() => takeOverEnv({ mcpUrl: 'http://127.0.0.1:4242/mcp', terminalId: 'term_1', token: '' })).toThrow(/token/);
        expect(() => takeOverEnv({ mcpUrl: 'http://0.0.0.0:4242/mcp', terminalId: 'term_1', token: 'tok' })).toThrow(/loopback/);
        expect(() => takeOverEnv({ mcpUrl: 'http://genie.local:4242/mcp', terminalId: 'term_1', token: 'tok' })).toThrow(/loopback/);
        expect(() => takeOverEnv({ mcpUrl: 'http://127.0.0.1:4242/mcp', terminalId: '', token: 'tok' })).toThrow(/terminal/);
    });

    it('when there is no server yet, there is NO environment — not a fake URL, not a stale one', () => {
        expect(takeOverEnv(null)).toEqual({});
    });
});

describe('the TUI configs reference the VARIABLE, never the value', () => {
    it('Claude Code: .mcp.json with the URL and an Authorization header of ${GENIE_MCP_TOKEN}', () => {
        const cfg = claudeMcpConfig({ mcpUrl: 'http://127.0.0.1:4242/mcp' });
        expect(cfg).toEqual({ mcpServers: { genie: { type: 'http', url: 'http://127.0.0.1:4242/mcp', headers: { Authorization: 'Bearer ${GENIE_MCP_TOKEN}' } } } });
        expect(JSON.stringify(cfg)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    });

    it('Codex: config.toml with bearer_token_env_var — the token never enters the file at all', () => {
        const toml = codexMcpConfig({ mcpUrl: 'http://127.0.0.1:4242/mcp' });
        expect(toml).toBe(['[mcp_servers.genie]', 'url = "http://127.0.0.1:4242/mcp"', 'bearer_token_env_var = "GENIE_MCP_TOKEN"', ''].join('\n'));
    });

    it('neither config can be built from a non-loopback URL', () => {
        expect(() => claudeMcpConfig({ mcpUrl: 'http://10.0.0.5:4242/mcp' })).toThrow(/loopback/);
        expect(() => codexMcpConfig({ mcpUrl: 'https://example.com/mcp' })).toThrow(/loopback/);
    });
});
