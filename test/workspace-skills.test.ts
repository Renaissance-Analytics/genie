import { describe, expect, it } from 'vitest';
import { GENIE_SKILLS, writeAgentSkills, type SkillFs } from '../src/main/agent-skills.js';

/**
 * GENIE 2'S SKILLS, AND GENIE 1'S RETIRED (the owner: Genie 2 manages all the workspace agent files). Genie 1 wrote
 * `genie-*` skills into `.claude/skills/` (Claude) and `.agents/skills/` (Codex) that send an agent to tools Genie 2
 * does not have — `connectToGenie`, `genieGuide`, `checkIssues`, `manageProcess`, `manageWorkspaces`, `manageGappDev`,
 * `registerSession` — and a handoff skill for an upgrade that no longer asks for one. Genie 2 writes its own skills,
 * naming only the tools its MCP serves; Genie 1's skills that have no Genie 2 meaning are backed up and removed; every
 * other skill (a person's, a plugin's) is left exactly as it is.
 */
function memFs(files: Record<string, string>) {
    const store = new Map(Object.entries(files));
    const dirs: string[] = [];
    const fs: SkillFs = {
        read: async (p) => store.get(p) ?? null,
        write: async (p, t) => { store.set(p, t); },
        remove: async (p) => { store.delete(p); },
        list: async (dir) => [...new Set([...store.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split('/')[0]!))],
        removeDir: async (d) => { if ([...store.keys()].some((k) => k.startsWith(`${d}/`))) throw new Error(`${d} is not empty`); dirs.push(d); },
    };
    return { fs, store, dirs };
}
const W = '/w/moic';
const run = (fs: SkillFs) => writeAgentSkills({ workspacePath: W, fs, stamp: '20261012' });

// The thirteen tools Genie 2's MCP registers (pinned by test/mcp-registrations.test.ts).
const SERVED = ['imDone', 'ForceTheQuestion', 'agentinbox', 'lists', 'thumbsUp', 'knowledge', 'manageTerminals', 'openFileForUser', 'submitFeedback', 'runAgent', 'services', 'sites', 'processes'];
const V1_ONLY = ['connectToGenie', 'genieGuide', 'checkIssues', 'manageProcess', 'manageWorkspaces', 'manageGappDev', 'registerSession', 'provisionWorkspaces'];

describe('Genie 2\'s skills', () => {
    it('name only tools Genie 2 serves, and each is written for both harnesses', async () => {
        const { fs, store } = memFs({});
        await run(fs);
        for (const s of GENIE_SKILLS) {
            const named = [...s.body.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!).filter((n) => /^(?:[a-z]+[A-Z]|ForceTheQuestion|agentinbox|lists|knowledge|services|sites|processes)/.test(n));
            for (const n of named) expect(SERVED, `${s.name} names ${n}`).toContain(n);
            for (const v1 of V1_ONLY) expect(s.body, `${s.name}`).not.toContain(v1);
            for (const dir of ['.claude/skills', '.agents/skills']) {
                const md = store.get(`${W}/${dir}/${s.name}/SKILL.md`)!;
                expect(md).toMatch(new RegExp(`^---\\nname: ${s.name}\\ndescription: `));
                expect(md).toContain(s.body);
            }
        }
        // Positive control: the skills do name the tools — a body naming nothing would pass the loop above.
        expect(GENIE_SKILLS.map((s) => s.body).join('\n')).toContain('`ForceTheQuestion`');
    });

    it('replace Genie 1\'s text in a skill of the same name', async () => {
        const { fs, store } = memFs({ [`${W}/.claude/skills/genie/SKILL.md`]: '---\nname: genie\n---\n\ncall `connectToGenie` and `genieGuide`\n' });
        await run(fs);
        expect(store.get(`${W}/.claude/skills/genie/SKILL.md`)).not.toContain('connectToGenie');
    });
});

describe('Genie 1\'s skills with no Genie 2 meaning', () => {
    it('are backed up, then removed with their folder; a person\'s or a plugin\'s skill stays byte-for-byte', async () => {
        const handoff = '---\nname: genie-handoff\n---\n\nwrite a handoff through imDone, then stop\n';
        const { fs, store, dirs } = memFs({
            [`${W}/.claude/skills/genie-handoff/SKILL.md`]: handoff,
            [`${W}/.agents/skills/genie-issuewatch/SKILL.md`]: 'use `checkIssues`',
            [`${W}/.agents/skills/genie/scripts/register-session.cjs`]: '// genie 1 codex binding',
            [`${W}/.claude/skills/genie-plugin-artboard/SKILL.md`]: 'artboard',
            [`${W}/.claude/skills/deploy/SKILL.md`]: 'my deploy steps',
        });
        await run(fs);
        expect(store.has(`${W}/.claude/skills/genie-handoff/SKILL.md`)).toBe(false);
        expect(store.has(`${W}/.agents/skills/genie-issuewatch/SKILL.md`)).toBe(false);
        expect(store.has(`${W}/.agents/skills/genie/scripts/register-session.cjs`)).toBe(false);
        expect(dirs).toEqual(expect.arrayContaining([`${W}/.claude/skills/genie-handoff`, `${W}/.agents/skills/genie-issuewatch`, `${W}/.agents/skills/genie/scripts`]));
        expect(store.get(`${W}/.agents/_genie/backups/skills/claude/genie-handoff.20261012/SKILL.md`)).toBe(handoff);
        expect(store.get(`${W}/.agents/_genie/backups/skills/agents/genie/scripts.20261012/register-session.cjs`)).toBe('// genie 1 codex binding');
        expect(store.get(`${W}/.claude/skills/genie-plugin-artboard/SKILL.md`)).toBe('artboard');
        expect(store.get(`${W}/.claude/skills/deploy/SKILL.md`)).toBe('my deploy steps');
    });

    it('a second sync changes nothing (idempotent: no writes, no new backups)', async () => {
        const { fs, store } = memFs({ [`${W}/.claude/skills/genie-handoff/SKILL.md`]: 'x' });
        await run(fs);
        const after = new Map(store);
        let writes = 0;
        const counting: SkillFs = { ...fs, write: async (p, t) => { writes++; await fs.write(p, t); } };
        await run(counting);
        expect(writes).toBe(0);
        expect(new Map(store)).toEqual(after);
    });
});
