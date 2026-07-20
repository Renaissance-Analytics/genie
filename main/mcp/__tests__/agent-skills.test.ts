import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Repo-scoped agent SKILLS. Genie's own workflow skill plus one per enabled
 * plugin that declares `agent.guide`, written for BOTH agents: Codex reads
 * `.agents/skills`, Claude Code reads `.claude/skills`.
 *
 * Why skills and not just tool descriptions: the guide also rides on each tool
 * description, but descriptions are ALWAYS in context and repeat once per tool.
 * A skill is written once per plugin and loaded on demand.
 *
 * Uses a REAL temp dir rather than the in-memory fs mock the sibling sync test
 * uses — pruning genuinely exercises readdir/rm over nested directories, which
 * a map-backed mock cannot represent faithfully.
 */

let settings: Record<string, string> = {};
let skills: unknown[] = [];

vi.mock('../../db', () => ({ getAllSettings: () => settings }));
vi.mock('../../plugins/registry', () => ({ pluginAgentSkills: () => skills }));

import { writeWorkspaceAgentMcp, genieCodexSkill, pluginSkillBody } from '../agent-config';

const URL = 'http://127.0.0.1:51717/mcp/tok';
let WS: string;

const codexRoot = () => path.join(WS, '.agents', 'skills');
const claudeRoot = () => path.join(WS, '.claude', 'skills');
const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

const PRESENTATION = {
    namespace: 'presentation',
    name: 'Presentation',
    description: 'Generate PowerPoint decks.',
    guide: 'Use presentation.createDeck when the user asks for a deck.',
    tools: [{ name: 'presentation.createDeck', description: 'Create a .pptx deck.' }],
};

beforeEach(() => {
    settings = {};
    skills = [];
    WS = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-skills-'));
});
afterEach(() => fs.rmSync(WS, { recursive: true, force: true }));

describe('agent skills sync', () => {
    it('writes the Genie skill for BOTH Codex and Claude', () => {
        writeWorkspaceAgentMcp(WS, true, URL);
        // Claude previously got no skill at all — only .mcp.json and AGENTS.md.
        expect(read(path.join(codexRoot(), 'genie', 'SKILL.md'))).toBe(genieCodexSkill());
        expect(read(path.join(claudeRoot(), 'genie', 'SKILL.md'))).toBe(genieCodexSkill());
    });

    it('writes a skill per plugin that declares a guide, for both agents', () => {
        skills = [PRESENTATION];
        writeWorkspaceAgentMcp(WS, true, URL);

        const body = pluginSkillBody(PRESENTATION as never);
        for (const root of [codexRoot(), claudeRoot()]) {
            const file = path.join(root, 'genie-plugin-presentation', 'SKILL.md');
            expect(read(file)).toBe(body);
        }
        // The body carries the guide AND names the namespaced tool, so an agent
        // reading the skill knows what to actually call.
        expect(body).toContain('Use presentation.createDeck when the user asks for a deck.');
        expect(body).toContain('`presentation.createDeck`');
    });

    it('prunes a plugin skill once the plugin is gone', () => {
        skills = [PRESENTATION];
        writeWorkspaceAgentMcp(WS, true, URL);
        const file = path.join(codexRoot(), 'genie-plugin-presentation', 'SKILL.md');
        expect(read(file)).not.toBeNull();

        // Plugin disabled/uninstalled → its skill must go, or the agent keeps
        // believing in tools that no longer resolve.
        skills = [];
        writeWorkspaceAgentMcp(WS, true, URL);
        expect(read(file)).toBeNull();
        expect(fs.existsSync(path.join(codexRoot(), 'genie-plugin-presentation'))).toBe(false);
    });

    it('never touches a skill it does not manage', () => {
        skills = [PRESENTATION];
        const mine = path.join(codexRoot(), 'my-own-skill', 'SKILL.md');
        fs.mkdirSync(path.dirname(mine), { recursive: true });
        fs.writeFileSync(mine, 'hand-authored');

        writeWorkspaceAgentMcp(WS, true, URL);
        skills = [];
        writeWorkspaceAgentMcp(WS, true, URL);

        // Only `genie-plugin-*` is Genie's to prune.
        expect(read(mine)).toBe('hand-authored');
    });

    it('respects the per-agent sync gates', () => {
        skills = [PRESENTATION];
        settings = { mcp_sync_claude: 'off' };
        writeWorkspaceAgentMcp(WS, true, URL);

        // Claude sync off ⇒ Genie neither writes nor removes anything of Claude's.
        expect(fs.existsSync(claudeRoot())).toBe(false);
        expect(read(path.join(codexRoot(), 'genie', 'SKILL.md'))).toBe(genieCodexSkill());
    });

    it('removes the Genie skill on disable, but keeps a user-edited one', () => {
        writeWorkspaceAgentMcp(WS, true, URL);
        const codexFile = path.join(codexRoot(), 'genie', 'SKILL.md');
        const claudeFile = path.join(claudeRoot(), 'genie', 'SKILL.md');
        fs.writeFileSync(claudeFile, '# my own version');

        writeWorkspaceAgentMcp(WS, false, null);

        expect(read(codexFile)).toBeNull();
        // Edited by the user → theirs to keep.
        expect(read(claudeFile)).toBe('# my own version');
    });

    it('still syncs skills when the endpoint is down', () => {
        skills = [PRESENTATION];
        // Workspace is MCP-enabled but the server is not listening. The guidance
        // is still correct — only the URL is missing.
        writeWorkspaceAgentMcp(WS, true, null);
        expect(read(path.join(claudeRoot(), 'genie-plugin-presentation', 'SKILL.md'))).not.toBeNull();
    });
});
