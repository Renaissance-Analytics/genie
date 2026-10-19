import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { osaHomeFiles, type OsaFacts } from '../src/core/osa-home.js';
import { OMARCHY_SKILLS_DIR, readOmarchySkills } from '../src/main/omarchy-skills.js';

/**
 * GENIE GETS WHAT OMARCHY GIVES AGENTS (the owner, 2026-10-19: "make sure that the genie agent has access to all of the
 * omarchy mcp tools and skills or whatever it provides for agents so genie can do it's job of system orchestration and
 * triage").
 *
 * Measured on omarchy-test (Omarchy 4.0.5): Omarchy ships NO MCP server. It ships agent SKILLS in
 * /usr/share/omarchy/default/agents/skills/<name>/ (`omarchy`, `diagnose-crash`; the manual names `omarchy-app` too),
 * symlinked into ~/.claude/skills, ~/.agents/skills and ~/.codex/skills, and the `omarchy` command center
 * (`omarchy commands --json` lists every command). genie runs in a home of its own, where project skills are what both
 * harnesses reliably load — so on an Omarchy host Genie copies every Omarchy skill there, and tells genie about the CLI.
 * Elsewhere it says nothing about Omarchy at all (the owner: never list what an agent cannot use).
 */

const facts = (omarchy: NonNullable<OsaFacts['omarchy']> | null): OsaFacts => ({ version: '2.0.0-beta.32', platform: 'linux', installDir: '/opt/Genie', genieHome: '/home/a/.genie', userData: '/home/a/.config/Genie', omarchy });
const SKILLS = {
    omarchy: { 'SKILL.md': '---\nname: omarchy\ndescription: Tailor this Omarchy system.\n---\n# Omarchy\n', 'reference/hyprland.md': 'binds…' },
    'diagnose-crash': { 'SKILL.md': '---\nname: diagnose-crash\ndescription: Make sense of a crash.\n---\n' },
};

describe('genie’s home on an Omarchy host', () => {
    it('every Omarchy skill, every file of it, for both harnesses (COUNTED: 3 files × 2)', () => {
        const files = osaHomeFiles('normal', facts({ skills: SKILLS }));
        const omarchyFiles = Object.keys(files).filter((k) => /skills\/(omarchy|diagnose-crash)\//.test(k)).sort();
        expect(omarchyFiles).toEqual([
            '.agents/skills/diagnose-crash/SKILL.md', '.agents/skills/omarchy/SKILL.md', '.agents/skills/omarchy/reference/hyprland.md',
            '.claude/skills/diagnose-crash/SKILL.md', '.claude/skills/omarchy/SKILL.md', '.claude/skills/omarchy/reference/hyprland.md',
        ]);
        expect(files['.claude/skills/omarchy/reference/hyprland.md']).toBe('binds…');
        // Genie's own skill is still there.
        expect(files['.claude/skills/genie-diagnostics/SKILL.md']).toBeDefined();
    });

    it('the instructions say this machine runs Omarchy, name its skills, and point at the omarchy CLI — in doctor mode too', () => {
        for (const mode of ['normal', 'doctor'] as const) {
            const md = osaHomeFiles(mode, facts({ skills: SKILLS }))['CLAUDE.md']!;
            expect(md, mode).toMatch(/runs Omarchy/);
            expect(md, mode).toContain('`omarchy commands --json`');
            expect(md, mode).toContain('`omarchy`, `diagnose-crash`');
        }
    });

    it('CONTROL: not an Omarchy host — no Omarchy file and no word about Omarchy (COUNTED: 0)', () => {
        const files = osaHomeFiles('normal', facts(null));
        expect(Object.keys(files).filter((k) => k.includes('omarchy') || k.includes('diagnose-crash'))).toEqual([]);
        expect(Object.values(files).join('\n').match(/omarchy/gi) ?? []).toHaveLength(0);
    });
});

describe('readOmarchySkills — the system folder, read', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-omarchy-skills-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('each folder with a SKILL.md is a skill, with every text file under it; a folder without one is not', async () => {
        await mkdir(join(dir, 'omarchy', 'reference'), { recursive: true });
        await writeFile(join(dir, 'omarchy', 'SKILL.md'), 'skill');
        await writeFile(join(dir, 'omarchy', 'reference', 'hyprland.md'), 'binds');
        await mkdir(join(dir, 'not-a-skill'));
        await writeFile(join(dir, 'not-a-skill', 'notes.md'), 'x');
        expect(await readOmarchySkills(dir)).toEqual({ omarchy: { 'SKILL.md': 'skill', 'reference/hyprland.md': 'binds' } });
    });

    it('no such folder (not Omarchy): null — never an empty set that reads as "Omarchy, with no skills"', async () => {
        expect(await readOmarchySkills(join(dir, 'missing'))).toBeNull();
    });
});

// THE REAL THING, where it exists: omarchy-test IS an Omarchy host. Skipped where Omarchy is not installed (CI's Ubuntu).
describe.skipIf(!existsSync(OMARCHY_SKILLS_DIR))('on a real Omarchy host', () => {
    it('reads Omarchy’s own skills — omarchy and diagnose-crash, each with its SKILL.md', async () => {
        const skills = await readOmarchySkills();
        expect(skills).not.toBeNull();
        expect(Object.keys(skills!)).toEqual(expect.arrayContaining(['omarchy', 'diagnose-crash']));
        expect(skills!['omarchy']!['SKILL.md']).toMatch(/^---[\s\S]*name:/);
    });
});
