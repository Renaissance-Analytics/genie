import { describe, expect, it, vi, beforeEach } from 'vitest';

// Verify the per-target config-sync gating (alpha.74): writeWorkspaceAgentMcp
// only touches a target's file when its mcp_sync_* setting is on, and leaves it
// ENTIRELY ALONE (no write, no remove) when off. We back fs with an in-memory
// map and drive the settings via the mocked db.

const files = new Map<string, string>();
let settings: Record<string, string> = {};

vi.mock('fs', () => ({
    default: {
        existsSync: (p: string) => files.has(p),
        readFileSync: (p: string) => {
            if (!files.has(p)) throw new Error('ENOENT');
            return files.get(p)!;
        },
        writeFileSync: (p: string, data: string) => {
            files.set(p, data);
        },
        mkdirSync: () => {},
    },
}));
vi.mock('../../db', () => ({ getAllSettings: () => settings }));

import path from 'node:path';
import { writeWorkspaceAgentMcp, writeWorkspaceTynnMcp } from '../agent-config';

// Build keys with path.join so they match the separators agent-config uses
// (backslashes on Windows, forward slashes elsewhere).
const WS = path.join('/ws', 'demo');
const mcpJson = path.join(WS, '.mcp.json');
const cursorJson = path.join(WS, '.cursor', 'mcp.json');
const codexToml = path.join(WS, '.codex', 'config.toml');
const agentsMd = path.join(WS, 'AGENTS.md');
const claudeMd = path.join(WS, 'CLAUDE.md');
const rulesMd = path.join(WS, 'RULES.md');
const managedShared = path.join(WS, '.agents', '_genie', 'shared.md');
const managedCodex = path.join(WS, '.agents', '_genie', 'genie-codex.md');
const managedClaude = path.join(WS, '.agents', '_genie', 'genie-claude.md');
const agentsBackup = path.join(WS, '.agents', '_genie', 'backups', 'AGENTS.md.pre-router.bak');
const claudeBackup = path.join(WS, '.agents', '_genie', 'backups', 'CLAUDE.md.pre-router.bak');
const codexSkill = path.join(WS, '.agents', 'skills', 'genie', 'SKILL.md');
const codexSessionHook = path.join(
    WS,
    '.agents',
    'skills',
    'genie',
    'scripts',
    'register-session.cjs',
);
const claudeChannelBridge = path.join(
    WS,
    '.agents',
    '_genie',
    'agentinbox-claude-channel.cjs',
);
const coreSkillNames = [
    'genie-orientation',
    'genie-attention',
    'genie-agentinbox',
    'genie-terminals',
    'genie-workspaces',
    'genie-knowledge',
    'genie-issuewatch',
];
const URL = 'http://127.0.0.1:51717/mcp/tok';

beforeEach(() => {
    files.clear();
    settings = {};
});

describe('writeWorkspaceAgentMcp — per-target sync gating', () => {
    it('migrates instruction files to harness-specific @ routers without losing human rules', () => {
        files.set(agentsMd, '# Project rules\n\nNever force-push.\n');
        files.set(claudeMd, '@AGENTS.md\n\n## Claude Code\n\nUse a narrow context window.\n');

        writeWorkspaceAgentMcp(WS, true, URL);

        expect(files.get(agentsMd)).toContain('@.agents/_genie/shared.md');
        expect(files.get(agentsMd)).toContain('@.agents/_genie/genie-codex.md');
        expect(files.get(agentsMd)).not.toContain('genie-claude.md');
        expect(files.get(claudeMd)).toContain('@.agents/_genie/shared.md');
        expect(files.get(claudeMd)).toContain('@.agents/_genie/genie-claude.md');
        expect(files.get(claudeMd)).not.toContain('genie-codex.md');
        expect(files.get(agentsMd)).not.toContain('@AGENTS.md');
        expect(files.get(agentsBackup)).toContain('Never force-push.');
        expect(files.get(claudeBackup)).toContain('Use a narrow context window.');
        expect(files.get(rulesMd)).toContain('Never force-push.');
        expect(files.get(rulesMd)).toContain('Use a narrow context window.');
        expect(files.get(managedShared)).toContain('GENIE PROTOCOL');
        expect(files.get(managedCodex)).toContain('Codex');
        expect(files.get(managedClaude)).toContain('Claude Code');
    });

    it('writes all targets when every sync flag is on (default)', () => {
        settings = { mcp_sync_claude: 'on', mcp_sync_cursor: 'on', mcp_sync_agents: 'on' };
        writeWorkspaceAgentMcp(WS, true, URL);
        expect(files.has(mcpJson)).toBe(true);
        expect(files.has(cursorJson)).toBe(true);
        expect(files.get(codexToml)).toContain('[mcp_servers.genie]');
        expect(files.get(codexToml)).toContain(`url = '${URL}'`);
        expect(files.get(codexToml)).toContain('[[hooks.SessionStart]]');
        expect(files.get(codexToml)).toContain('matcher = "startup|resume|clear"');
        expect(files.get(codexToml)).toContain(codexSessionHook.replace(/\\/g, '\\\\'));
        expect(files.get(codexSkill)).toContain('name: genie');
        expect(files.get(codexSkill)).toContain('initializeWorkspace');
        expect(files.get(codexSessionHook)).toContain('payload.session_id');
        expect(files.get(codexSessionHook)).toContain("action: 'registerSession'");
        expect(files.get(codexSessionHook)).toContain('process.env.GENIE_MCP_URL');
        expect(files.get(codexSessionHook)).toContain('const attempts = 3');
        expect(files.get(codexSessionHook)).toContain('await delay(150 * attempt)');
        for (const name of coreSkillNames) {
            const file = path.join(WS, '.agents', 'skills', name, 'SKILL.md');
            expect(files.get(file)).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
        }
        expect(
            files.get(path.join(WS, '.agents', 'skills', 'genie-agentinbox', 'SKILL.md')),
        ).toContain('registerSession');
        expect(
            files.get(path.join(WS, '.agents', 'skills', 'genie-orientation', 'SKILL.md')),
        ).toContain('initializeWorkspace');
        expect(JSON.parse(files.get(mcpJson)!).mcpServers.genie.url).toBe(URL);
    });

    it('installs AgentInbox as a Claude Code Channel without terminal-input delivery', () => {
        settings = { mcp_sync_claude: 'on' };

        writeWorkspaceAgentMcp(WS, true, URL);

        const config = JSON.parse(files.get(mcpJson)!);
        expect(config.mcpServers['genie-agentinbox-channel']).toEqual({
            command: process.execPath,
            args: [claudeChannelBridge],
            env: { GENIE_MCP_URL: URL },
        });
        const bridge = files.get(claudeChannelBridge)!;
        expect(bridge).toContain("'claude/channel'");
        expect(bridge).toContain("'notifications/claude/channel'");
        expect(bridge).toContain("action: 'registerTransport'");
        expect(bridge).not.toMatch(/node-pty|writeToPty|terminal:write|manageTerminals/);
    });

    it('leaves .cursor/mcp.json untouched when mcp_sync_cursor is off', () => {
        settings = { mcp_sync_cursor: 'off' };
        writeWorkspaceAgentMcp(WS, true, URL);
        expect(files.has(mcpJson)).toBe(true); // Claude still synced (default on)
        expect(files.has(cursorJson)).toBe(false); // Cursor never created
    });

    it('does not REMOVE an off target on disable (manual edits stick)', () => {
        // User has a Cursor config with the genie entry; Cursor sync is off.
        files.set(
            cursorJson,
            JSON.stringify({ mcpServers: { genie: { url: URL }, other: { command: 'x' } } }),
        );
        settings = { mcp_sync_cursor: 'off' };
        writeWorkspaceAgentMcp(WS, false, null); // disable
        // The file is left byte-for-byte alone — genie entry NOT removed.
        expect(JSON.parse(files.get(cursorJson)!).mcpServers.genie).toEqual({ url: URL });
    });

    it('leaves .mcp.json untouched when mcp_sync_claude is off', () => {
        settings = { mcp_sync_claude: 'off' };
        writeWorkspaceAgentMcp(WS, true, URL);
        expect(files.has(mcpJson)).toBe(false);
        expect(files.has(cursorJson)).toBe(true); // Cursor default-on
    });

    it('leaves project Codex config untouched when mcp_sync_codex is off', () => {
        files.set(codexToml, 'model = "gpt-5"\n');
        settings = { mcp_sync_codex: 'off' };
        writeWorkspaceAgentMcp(WS, true, URL);
        expect(files.get(codexToml)).toBe('model = "gpt-5"\n');
        expect(files.has(codexSessionHook)).toBe(false);
        for (const name of coreSkillNames) {
            expect(
                files.has(path.join(WS, '.agents', 'skills', name, 'SKILL.md')),
            ).toBe(false);
        }
    });

    it('writes Tynn to project Codex config using the environment token', () => {
        writeWorkspaceTynnMcp(WS, true, {
            url: 'https://tynn.test/mcp/project',
            token: 'rpk_SECRET',
        });
        expect(files.get(codexToml)).toContain('[mcp_servers.tynn]');
        expect(files.get(codexToml)).toContain("bearer_token_env_var = 'TYNN_AGENT_TOKEN'");
        expect(files.get(codexToml)).not.toContain('rpk_SECRET');
    });
});
