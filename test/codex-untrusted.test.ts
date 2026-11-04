import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexFolderSkills } from '../src/main/genie-instructions.js';
import { codexTrustOptions, type GenieInstructionFiles } from '../src/main/session-host.js';

/**
 * A CODEX AGENT IN AN UNTRUSTED WORKSPACE (measured, CLI 0.166.0, app-server mode, against a stand-in API): marking a folder
 * untrusted stops neither its AGENTS.md nor its skills. project_doc_max_bytes=0 stops the first, and skills.config naming each
 * skill stops the second; no general switch does. The CLI reads skills from .agents/skills and .codex/skills, at any depth, from
 * the working folder up to the git root: not .claude/skills, not above the root, not below the working folder.
 */

let root: string;
const skill = (...parts: string[]) => {
    const at = join(root, ...parts);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');
    return join(at, 'SKILL.md');
};
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codex-untrusted-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const FILES = (folderSkills: string[]): GenieInstructionFiles => ({ promptFile: '/g/prompt.md', pluginDir: '/g/plugin', promptText: 'words', folderSkills });

describe('the options', () => {
    it('trusted: none', () => {
        expect(codexTrustOptions({}, null)).toEqual({});
        expect(codexTrustOptions({ binaryArgs: ['/s.mjs'] }, null)).toEqual({});
    });

    it('untrusted, with no skills: AGENTS.md off', () => {
        expect(codexTrustOptions({}, FILES([]))).toEqual({ binaryArgs: ['-c', 'project_doc_max_bytes=0'] });
    });

    it('each skill by name, disabled, and a path with a backslash or a quote stays one string', () => {
        const { binaryArgs } = codexTrustOptions({}, FILES(['C:\\Users\\Jo "J" Doe\\.agents\\skills\\a\\SKILL.md', '/w/.codex/skills/b/SKILL.md']));
        expect(binaryArgs).toEqual(['-c', 'project_doc_max_bytes=0', '-c', 'skills.config=[{path="C:\\\\Users\\\\Jo \\"J\\" Doe\\\\.agents\\\\skills\\\\a\\\\SKILL.md",enabled=false},{path="/w/.codex/skills/b/SKILL.md",enabled=false}]']);
    });

    it('a provider configured as a script stays first: these are arguments to it', () => {
        expect(codexTrustOptions({ binaryArgs: ['/s.mjs'] }, FILES([])).binaryArgs).toEqual(['/s.mjs', '-c', 'project_doc_max_bytes=0']);
    });
});

describe('which skills', () => {
    const repo = () => { mkdirSync(join(root, 'repo', '.git'), { recursive: true }); return join(root, 'repo'); };

    it('both folders at the top, at any depth', async () => {
        const dir = repo();
        const found = [skill('repo', '.agents', 'skills', 'a'), skill('repo', '.codex', 'skills', 'group', 'deeper', 'b')];
        expect((await codexFolderSkills(dir)).sort()).toEqual(found.sort());
    });

    it('from a subfolder, up to the git root: its own and the root\'s', async () => {
        repo();
        const found = [skill('repo', '.agents', 'skills', 'a'), skill('repo', 'sub', '.agents', 'skills', 'b')];
        mkdirSync(join(root, 'repo', 'sub', 'deep'), { recursive: true });
        expect((await codexFolderSkills(join(root, 'repo', 'sub', 'deep'))).sort()).toEqual(found.sort());
    });

    it('not above the git root, not below the working folder, and not a folder Codex does not read', async () => {
        const dir = repo();
        skill('.agents', 'skills', 'above');
        skill('repo', 'sub', '.agents', 'skills', 'below');
        skill('repo', '.claude', 'skills', 'claude');
        expect(await codexFolderSkills(dir)).toEqual([]);
    });

    it('with no git root, the working folder alone', async () => {
        const dir = join(root, 'plain');
        mkdirSync(dir, { recursive: true });
        skill('.agents', 'skills', 'parent');
        const found = skill('plain', '.agents', 'skills', 'own');
        expect(await codexFolderSkills(dir)).toEqual([found]);
    });

    it('a file that is not a skill is not named', async () => {
        const dir = repo();
        mkdirSync(join(dir, '.agents', 'skills', 'a'), { recursive: true });
        writeFileSync(join(dir, '.agents', 'skills', 'a', 'notes.md'), 'x');
        expect(await codexFolderSkills(dir)).toEqual([]);
    });
});
