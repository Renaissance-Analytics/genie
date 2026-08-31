import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wireGenieOsWorkspace } from '../os-workspace';

/**
 * The Genie OSA had NO Genie wiring at all.
 *
 * `ensureGenieOsWorkspace` creates the `.agi` envelope and stops there. Every
 * `writeWorkspaceAgentMcp` call site is keyed on a REGISTERED workspace row —
 * and the OSA deliberately has none (`workspace_id: null`, so deleting a project
 * can never delete the workstation operator). Nothing else ever wired it, so its
 * folder had no `.mcp.json`, no `.agents/skills/`, and no Codex config.
 *
 * Confirmed on the owner's machine before this was written: `genie-os.agi` held
 * `AGENTS.md`, `README.md`, `project.json`, `repos/` — and nothing else.
 *
 * The visible consequence, from the owner's first boot of the current build: the
 * OSA reported that `manageWorkspaces`, `registerAgent`, `runAgent` and
 * `manageTerminals` "aren't in my toolset — I can't call them", and that the
 * `genie-agent-builder` skill it was being told to act as did not exist. It was
 * right on both counts. The workstation operator — the agent that is supposed to
 * manage every workspace, onboarding, toolchain installs and upgrades — booted
 * with none of the tools its own instructions told it to use.
 *
 * A workspace-shaped folder needs workspace-shaped wiring, whether or not it has
 * a row in the database.
 */

let syncCalls: Array<{ path: string; enabled: boolean; url: string | null }> = [];

vi.mock('../../mcp/agent-config', () => ({
    writeWorkspaceAgentMcp: (p: string, enabled: boolean, url: string | null) => {
        syncCalls.push({ path: p, enabled, url });
    },
    osAgentBuilderSkill: () =>
        ['---', 'name: genie-agent-builder', 'description: d', '---', '', 'body', ''].join(
            String.fromCharCode(10),
        ),
}));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-osa-wiring-'));

beforeEach(() => {
    syncCalls = [];
});

describe('wiring the Genie OS workspace', () => {
    it('syncs the OSA folder the way a real workspace is synced', () => {
        const folder = path.join(tmpRoot, 'genie-os.agi');
        fs.mkdirSync(folder, { recursive: true });

        wireGenieOsWorkspace(folder, 'http://127.0.0.1:51717/mcp/tok');

        expect(syncCalls).toHaveLength(1);
        expect(syncCalls[0]).toMatchObject({
            path: folder,
            enabled: true,
            url: 'http://127.0.0.1:51717/mcp/tok',
        });
    });

    it('creates an AGENTS.md first, because the sync refuses a folder without one', () => {
        // `writeWorkspaceAgentMcp` returns early unless an agents doc already
        // exists — it deliberately does not litter one into projects that do not
        // use one. The OSA's folder DOES have one in practice, but a fresh
        // envelope may not yet, and silently doing nothing is how this stayed
        // broken. So the wiring guarantees the precondition it depends on.
        const folder = path.join(tmpRoot, 'fresh.agi');
        fs.mkdirSync(folder, { recursive: true });

        wireGenieOsWorkspace(folder, 'http://x/mcp/t');

        expect(fs.existsSync(path.join(folder, 'AGENTS.md'))).toBe(true);
        expect(syncCalls).toHaveLength(1);
    });

    it('leaves an existing AGENTS.md alone', () => {
        // It is the operator's own instructions file and may have been edited.
        const folder = path.join(tmpRoot, 'existing.agi');
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'AGENTS.md'), '# Mine\n');

        wireGenieOsWorkspace(folder, 'http://x/mcp/t');

        expect(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8')).toBe('# Mine\n');
    });

    it('does not sync when there is no endpoint to point at', () => {
        // The MCP server may not have a port yet. Writing a config with a null
        // URL would leave a BROKEN `.mcp.json` on disk that looks configured —
        // worse than an absent one, because nothing would retry it.
        const folder = path.join(tmpRoot, 'noport.agi');
        fs.mkdirSync(folder, { recursive: true });

        wireGenieOsWorkspace(folder, null);

        expect(syncCalls).toEqual([]);
    });
});

/**
 * The AgentBuilder skill is INSTALLED, not pasted into the prompt.
 *
 * It was concatenated into `agent_instructions` and delivered as a positional
 * opening prompt — ~1.2KB of SKILL.md, frontmatter and all, typed into the TUI.
 * The owner's screenshot shows the result: the same persona block arriving three
 * times in a row (once per relaunch, since `maybeRelaunchAgent` re-submits
 * `agent_instructions` every time), with no task attached, describing a skill
 * the agent could correctly see it did not have.
 *
 * A skill is a FILE. Installing it means the agent loads it when it is relevant,
 * the way every other skill works, instead of wearing it as an opening prompt it
 * cannot dismiss.
 */
describe('the AgentBuilder skill', () => {
    it('is written into the OSA workspace as a skill file', () => {
        const folder = path.join(tmpRoot, 'skills.agi');
        fs.mkdirSync(folder, { recursive: true });

        wireGenieOsWorkspace(folder, 'http://x/mcp/t');

        const skill = path.join(folder, '.agents', 'skills', 'genie-agent-builder', 'SKILL.md');
        expect(fs.existsSync(skill)).toBe(true);
        expect(fs.readFileSync(skill, 'utf8')).toMatch(/^---\nname: genie-agent-builder\n/);
    });

    it('is written for Claude Code as well as Codex', () => {
        // The two harnesses read different roots, and the operator must work
        // whichever TUI the workstation defaults to.
        const folder = path.join(tmpRoot, 'skills-both.agi');
        fs.mkdirSync(folder, { recursive: true });

        wireGenieOsWorkspace(folder, 'http://x/mcp/t');

        expect(
            fs.existsSync(path.join(folder, '.claude', 'skills', 'genie-agent-builder', 'SKILL.md')),
        ).toBe(true);
    });

    it('is not written when there is no endpoint — nothing is half-configured', () => {
        const folder = path.join(tmpRoot, 'skills-noport.agi');
        fs.mkdirSync(folder, { recursive: true });

        wireGenieOsWorkspace(folder, null);

        expect(fs.existsSync(path.join(folder, '.agents', 'skills'))).toBe(false);
    });
});
