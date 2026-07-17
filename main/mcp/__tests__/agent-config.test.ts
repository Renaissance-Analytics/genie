import { describe, expect, it } from 'vitest';
import {
    applyAgentsSection,
    applyCodexMcpLaunchArgs,
    applyCodexServerBlock,
    applyGenieServer,
    claudeEntry,
    codexMcpLaunchArgs,
    loadWorkspaceTerminalEnv,
    readTynnMcpBearerToken,
    cursorEntry,
    ensureClaudeProjectMcpEnabled,
    GENIE_SERVER_NAME,
    readTynnMcpUrl,
    withCodexMcpLaunch,
} from '../agent-config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL = 'http://127.0.0.1:51717/mcp/abc123';
const entry = claudeEntry(URL);

describe('applyGenieServer', () => {
    it('adds the genie server to an empty/new config', () => {
        expect(applyGenieServer(null, entry, true)).toEqual({
            mcpServers: { genie: entry },
        });
    });

    it('merges alongside existing servers without clobbering them', () => {
        const existing = {
            mcpServers: { other: { command: 'x' } },
            someOtherKey: 1,
        };
        expect(applyGenieServer(existing, entry, true)).toEqual({
            mcpServers: { other: { command: 'x' }, genie: entry },
            someOtherKey: 1,
        });
    });

    it('removes only the genie entry on disable, keeping the rest', () => {
        const existing = {
            mcpServers: { other: { command: 'x' }, genie: entry },
        };
        expect(applyGenieServer(existing, entry, false)).toEqual({
            mcpServers: { other: { command: 'x' } },
        });
    });

    it('returns null when disabling and no config exists (nothing to write)', () => {
        expect(applyGenieServer(null, entry, false)).toBeNull();
    });

    it('disabling an existing config with no genie entry leaves it intact', () => {
        const existing = { mcpServers: { other: { command: 'x' } } };
        expect(applyGenieServer(existing, entry, false)).toEqual(existing);
    });

    it('bakes a static literal url (no ${ENV} ref to expand)', () => {
        const out = applyGenieServer(null, entry, true) as {
            mcpServers: Record<string, { url: string }>;
        };
        expect(out.mcpServers[GENIE_SERVER_NAME].url).toBe(URL);
        expect(out.mcpServers[GENIE_SERVER_NAME].url).not.toContain('${');
    });

    it('claudeEntry sets an explicit http transport type; cursorEntry omits it', () => {
        expect(claudeEntry(URL)).toEqual({ type: 'http', url: URL });
        expect(cursorEntry(URL)).toEqual({ url: URL });
    });
});

describe('Codex MCP launch overrides', () => {
    it('merges a managed project MCP block without clobbering other Codex settings', () => {
        const existing = 'model = "gpt-5"\n';
        const next = applyCodexServerBlock(existing, 'genie', URL, null, true);
        expect(next).toContain(existing);
        expect(next).toContain('# BEGIN GENIE MCP: genie');
        expect(next).toContain('[mcp_servers.genie]');
        expect(next).toContain(`url = '${URL}'`);
        expect(applyCodexServerBlock(next, 'genie', URL, null, true)).toBe(next);
        expect(applyCodexServerBlock(next, 'genie', URL, null, false)).toBe(existing);
    });

    it('uses an environment-backed bearer token for Tynn project config', () => {
        const next = applyCodexServerBlock(
            '',
            'tynn',
            'https://tynn.test/mcp/project',
            'TYNN_AGENT_TOKEN',
            true,
        );
        expect(next).toContain(`bearer_token_env_var = 'TYNN_AGENT_TOKEN'`);
        expect(next).not.toContain('Bearer ');
    });

    it('renders Genie and Tynn as Codex -c overrides without embedding the Tynn token', () => {
        const out = codexMcpLaunchArgs({
            genieUrl: 'http://127.0.0.1:51717/mcp/abc123',
            tynnUrl: 'https://tynn.test/mcp/project',
        });
        expect(out).toContain(`-c "mcp_servers.genie.url='http://127.0.0.1:51717/mcp/abc123'"`);
        expect(out).toContain(`-c "mcp_servers.tynn.url='https://tynn.test/mcp/project'"`);
        expect(out).toContain(`-c "mcp_servers.tynn.bearer_token_env_var='TYNN_AGENT_TOKEN'"`);
        expect(out).not.toContain('Bearer ');
        expect(out).not.toContain('rpk_');
    });

    it('appends only configured servers to a Codex command', () => {
        expect(
            applyCodexMcpLaunchArgs('codex --model gpt-5', {
                genieUrl: 'http://127.0.0.1:51717/mcp/abc123',
            }),
        ).toBe(`codex --model gpt-5 -c "mcp_servers.genie.url='http://127.0.0.1:51717/mcp/abc123'"`);
    });

    it('gates the launch override: only Codex, only when sync is on', () => {
        const genieUrl = 'http://127.0.0.1:51717/mcp/abc123';
        const tynnUrl = 'https://tynn.test/mcp/project';

        // Codex + sync on → overrides appended.
        expect(
            withCodexMcpLaunch('codex', { agent: 'codex', mcpSyncCodexOff: false, genieUrl, tynnUrl }),
        ).toBe(applyCodexMcpLaunchArgs('codex', { genieUrl, tynnUrl }));

        // Codex + sync OFF → untouched.
        expect(
            withCodexMcpLaunch('codex', { agent: 'codex', mcpSyncCodexOff: true, genieUrl, tynnUrl }),
        ).toBe('codex');

        // Non-Codex agent → untouched even with sync on + URLs present.
        expect(
            withCodexMcpLaunch('claude', { agent: 'claude', mcpSyncCodexOff: false, genieUrl, tynnUrl }),
        ).toBe('claude');

        // Codex + sync on but no resolvable URLs (no workspace) → untouched.
        expect(
            withCodexMcpLaunch('codex', { agent: 'codex', mcpSyncCodexOff: false, genieUrl: null, tynnUrl: null }),
        ).toBe('codex');
    });

    it('percent-encodes a stray single quote so the TOML literal stays valid', () => {
        const out = codexMcpLaunchArgs({ genieUrl: "http://h/mcp/a'b" });
        expect(out).toBe(`-c "mcp_servers.genie.url='http://h/mcp/a%27b'"`);
        expect(out).not.toContain("a''b"); // not the invalid TOML double-quote-escape
    });

    it('reads the provisioned Tynn MCP URL from .mcp.json', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-tynn-url-'));
        fs.writeFileSync(
            path.join(dir, '.mcp.json'),
            JSON.stringify({
                mcpServers: {
                    tynn: {
                        type: 'http',
                        url: 'https://tynn.test/mcp/project',
                        headers: { Authorization: 'Bearer rpk_SECRET' },
                    },
                },
            }),
        );
        expect(readTynnMcpUrl(dir)).toBe('https://tynn.test/mcp/project');
        expect(readTynnMcpBearerToken(dir)).toBe('rpk_SECRET');
        expect(loadWorkspaceTerminalEnv(dir)).toMatchObject({ TYNN_AGENT_TOKEN: 'rpk_SECRET' });
    });

    it('heals Codex terminal env from the literal MCP token when .env is absent', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-codex-env-'));
        fs.writeFileSync(
            path.join(dir, '.mcp.json'),
            JSON.stringify({
                mcpServers: {
                    tynn: {
                        type: 'http',
                        url: 'https://tynn.test/mcp/project',
                        headers: { Authorization: 'Bearer rpk_FROM_CONFIG' },
                    },
                },
            }),
        );
        expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
        expect(loadWorkspaceTerminalEnv(dir)).toEqual({ TYNN_AGENT_TOKEN: 'rpk_FROM_CONFIG' });
    });
});

describe('applyAgentsSection', () => {
    const BEGIN = '<!-- BEGIN GENIE MCP (auto-managed by Genie) -->';
    const END = '<!-- END GENIE MCP (auto-managed by Genie) -->';

    it('appends the genie block to the end of an existing AGENTS.md', () => {
        const out = applyAgentsSection('# My Project\n\nNotes.\n', true);
        expect(out.startsWith('# My Project\n\nNotes.\n')).toBe(true);
        expect(out).toContain(BEGIN);
        expect(out).toContain(END);
        expect(out).toContain('genieGuide');
        // beta.5: the block lists ONLY agent-callable tools — the user-run
        // initializeWorkspace prompt is gone; imDone/ForceTheQuestion/manageProcess stay.
        expect(out).toContain('imDone');
        expect(out).toContain('ForceTheQuestion');
        expect(out).toContain('manageProcess');
        expect(out).not.toContain('initializeWorkspace');
    });

    it('is idempotent — re-running does not duplicate the block', () => {
        const once = applyAgentsSection('# P\n', true);
        const twice = applyAgentsSection(once, true);
        expect(twice).toBe(once);
        expect(twice.match(/BEGIN GENIE MCP/g)?.length).toBe(1);
    });

    it('updates the block in place when content changes, not appends', () => {
        const stale = `# P\n\n${BEGIN}\n## Genie MCP\n\nOLD BODY\n${END}\n`;
        const out = applyAgentsSection(stale, true);
        expect(out.match(/BEGIN GENIE MCP/g)?.length).toBe(1);
        expect(out).not.toContain('OLD BODY');
        expect(out).toContain('genieGuide');
    });

    it('removes the block on disable, leaving the rest intact', () => {
        const withBlock = applyAgentsSection('# P\n\nbody\n', true);
        const out = applyAgentsSection(withBlock, false);
        expect(out).not.toContain(BEGIN);
        expect(out).toContain('# P');
        expect(out).toContain('body');
    });

    it('disable is a no-op when no block is present', () => {
        const input = '# P\n\nbody\n';
        expect(applyAgentsSection(input, false)).toBe(input);
    });

    it('injects the Ai.System instructions INSIDE the block when provided', () => {
        const ai = 'Always prefer TypeScript. Never touch /vendor.';
        const out = applyAgentsSection('# P\n', true, ai);
        // present, exactly once, and bracketed by the markers (inside the block)
        expect(out).toContain(ai);
        expect(out).toContain('### Ai.System');
        const begin = out.indexOf(BEGIN);
        const end = out.indexOf(END);
        const aiAt = out.indexOf(ai);
        expect(aiAt).toBeGreaterThan(begin);
        expect(aiAt).toBeLessThan(end);
        // still a single block, and the brief is still present
        expect(out.match(/BEGIN GENIE MCP/g)?.length).toBe(1);
        expect(out).toContain('genieGuide');
    });

    it('empty aiSystem is byte-identical to the brief-only block (back-compat)', () => {
        const base = '# My Project\n\nNotes.\n';
        expect(applyAgentsSection(base, true, '')).toBe(applyAgentsSection(base, true));
        // whitespace-only is treated as empty (trimmed away)
        expect(applyAgentsSection(base, true, '   \n  ')).toBe(applyAgentsSection(base, true));
    });

    it('re-syncing replaces the Ai.System text in place (never duplicates)', () => {
        const once = applyAgentsSection('# P\n', true, 'FIRST INSTRUCTIONS');
        const twice = applyAgentsSection(once, true, 'SECOND INSTRUCTIONS');
        expect(twice.match(/BEGIN GENIE MCP/g)?.length).toBe(1);
        expect(twice).not.toContain('FIRST INSTRUCTIONS');
        expect(twice).toContain('SECOND INSTRUCTIONS');
    });

    it('disable strips the whole block even when it carried Ai.System text', () => {
        const ai = 'Secret workspace instructions.';
        const withBlock = applyAgentsSection('# P\n\nbody\n', true, ai);
        const out = applyAgentsSection(withBlock, false);
        expect(out).not.toContain(BEGIN);
        expect(out).not.toContain(ai);
        expect(out).not.toContain('### Ai.System');
        expect(out).toContain('# P');
        expect(out).toContain('body');
    });
});

describe('ensureClaudeProjectMcpEnabled (genie #10 — auto-approve project MCP)', () => {
    const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'genie-mcp-enable-'));
    const settingsPath = (dir: string) => path.join(dir, '.claude', 'settings.local.json');

    it('creates .claude/settings.local.json with enableAllProjectMcpServers', () => {
        const dir = mk();
        ensureClaudeProjectMcpEnabled(dir);
        expect(JSON.parse(fs.readFileSync(settingsPath(dir), 'utf8'))).toEqual({
            enableAllProjectMcpServers: true,
        });
    });

    it('merges the flag into an existing settings file, preserving other keys', () => {
        const dir = mk();
        fs.mkdirSync(path.dirname(settingsPath(dir)), { recursive: true });
        fs.writeFileSync(
            settingsPath(dir),
            JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: {} }),
        );
        ensureClaudeProjectMcpEnabled(dir);
        expect(JSON.parse(fs.readFileSync(settingsPath(dir), 'utf8'))).toEqual({
            permissions: { allow: ['Bash'] },
            hooks: {},
            enableAllProjectMcpServers: true,
        });
    });

    it('is idempotent — a no-op when already enabled (leaves other keys untouched)', () => {
        const dir = mk();
        fs.mkdirSync(path.dirname(settingsPath(dir)), { recursive: true });
        fs.writeFileSync(
            settingsPath(dir),
            JSON.stringify({ enableAllProjectMcpServers: true, custom: 1 }),
        );
        ensureClaudeProjectMcpEnabled(dir);
        expect(JSON.parse(fs.readFileSync(settingsPath(dir), 'utf8'))).toEqual({
            enableAllProjectMcpServers: true,
            custom: 1,
        });
    });

    it('is a no-op for an empty workspace path (never throws)', () => {
        expect(() => ensureClaudeProjectMcpEnabled('')).not.toThrow();
    });
});
