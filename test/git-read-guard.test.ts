import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitIgnoredOver } from '../src/main/dotenv-sync.js';
import { GIT_NEEDS_TRUST, folderGitConfig, setGitReadPolicy, trustAwarePolicy } from '../src/main/git-read-policy.js';
import { gitFileStatus, gitLogSince, gitShowHead, gitTreeStatus } from '../src/main/git-ports.js';
import { repoDiff, repoStage, repoStatus } from '../src/main/repo-git.js';

/**
 * GIT IN A FOLDER THE PERSON HAS NOT TRUSTED, through the real functions and the real git. A key in the folder's own config that could run something means no git runs there; a plain repository is read as ever; once trusted, git runs as git does.
 */
let root: string;
let repo: string;
let mark: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const tool = () => {
    const file = join(root, 'tool.sh');
    writeFileSync(file, `#!/bin/sh\necho ran > '${mark.replace(/\\/g, '/')}'\ncat 2>/dev/null\nexit 0\n`);
    chmodSync(file, 0o755);
    return file.replace(/\\/g, '/');
};
const ran = () => existsSync(mark);
const untrusted = () => setGitReadPolicy(trustAwarePolicy(() => false));

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'git-guard-'));
    mark = join(root, 'mark.txt');
    repo = join(root, 'repo');
    mkdirSync(repo);
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
});
afterEach(() => {
    setGitReadPolicy(null);
    rmSync(root, { recursive: true, force: true });
});

describe('a plain repository, untrusted', () => {
    beforeEach(untrusted);
    it('is read as ever: there is nothing in it that could run', async () => {
        expect(await gitTreeStatus(repo)).toMatchObject({ 'a.txt': 'modified' });
        expect(await gitFileStatus(repo, 'a.txt')).toBe('modified');
        expect(await gitShowHead(repo, 'a.txt')).toBe('one\n');
        expect((await gitLogSince(repo, 0)).map((c) => c.subject)).toEqual(['first']);
        const status = await repoStatus(repo, '.');
        expect(status.ok).toBe(true);
    });
});

describe('a key that could run something, untrusted', () => {
    beforeEach(() => { git('config', 'core.fsmonitor', tool()); untrusted(); });

    it('gitTreeStatus: nothing ran, and it has nothing to say', async () => { expect(await gitTreeStatus(repo)).toEqual({}); expect(ran()).toBe(false); });
    it('gitFileStatus', async () => { expect(await gitFileStatus(repo, 'a.txt')).toBeNull(); expect(ran()).toBe(false); });
    it('gitShowHead', async () => { expect(await gitShowHead(repo, 'a.txt')).toBeNull(); expect(ran()).toBe(false); });
    it('gitLogSince', async () => { expect(await gitLogSince(repo, 0)).toEqual([]); expect(ran()).toBe(false); });
    it('repoStatus says why, in words', async () => {
        const r = await repoStatus(repo, '.');
        expect(r).toEqual({ ok: false, error: GIT_NEEDS_TRUST });
        expect(ran()).toBe(false);
    });
    it('repoStage says why, and stages nothing', async () => {
        expect(await repoStage(repo, '.', ['a.txt'])).toEqual({ ok: false, error: GIT_NEEDS_TRUST });
        expect(ran()).toBe(false);
    });
    it('the .env check does not ask git', async () => {
        const asked: string[] = [];
        const check = gitIgnoredOver(async (binary, args) => { asked.push(binary); return new Promise((resolve) => { execFile(binary, [...args], { cwd: repo }, (error) => resolve({ stdout: '', exitCode: error ? 1 : 0 })); }); });
        expect(await check(repo, '.env')).toBe('no-repo');
        expect(asked).toEqual([]);
    });
});

describe('the other ways a config can say it', () => {
    beforeEach(untrusted);
    it('diff.external, through repoDiff', async () => { git('config', 'diff.external', tool()); await repoDiff(repo, '.', 'a.txt', false); expect(ran()).toBe(false); });
    it('a filter, through gitTreeStatus', async () => {
        writeFileSync(join(repo, '.gitattributes'), '*.txt filter=x\n');
        git('config', 'filter.x.clean', tool());
        await gitTreeStatus(repo);
        expect(ran()).toBe(false);
    });
    it('an included file', async () => {
        const included = join(root, 'included.cfg');
        writeFileSync(included, `[core]\n\tfsmonitor = ${tool()}\n`);
        git('config', 'include.path', included.replace(/\\/g, '/'));
        await gitTreeStatus(repo);
        expect(ran()).toBe(false);
    });
    it('a worktree config, which --local does not show', async () => {
        git('config', 'extensions.worktreeConfig', 'true');
        git('config', '--worktree', 'core.fsmonitor', tool());
        expect((await folderGitConfig(repo)).map((e) => e.key)).toContain('core.fsmonitor');
        await gitTreeStatus(repo);
        expect(ran()).toBe(false);
    });
    it('a folder inside a repository that has one', async () => {
        git('config', 'core.fsmonitor', tool());
        const inner = join(repo, 'inner');
        mkdirSync(inner);
        await gitTreeStatus(inner);
        expect(ran()).toBe(false);
    });
});

describe('trusted', () => {
    it('CONTROL: the same key, and git runs it, so every row above is the guard at work', async () => {
        git('config', 'core.fsmonitor', tool());
        setGitReadPolicy(trustAwarePolicy(() => true));
        await gitTreeStatus(repo);
        expect(ran()).toBe(true);
    });
});

describe('a commit whose subject holds the separator', () => {
    it('keeps its author and time', async () => {
        git('commit', '-q', '--allow-empty', '-m', `odd${String.fromCharCode(0x1f)}FORGED${String.fromCharCode(0x1f)}0`);
        const [newest] = await gitLogSince(repo, 0);
        expect(newest?.author).toBe('t');
        expect(newest?.at).toBeGreaterThan(1_000_000_000_000);
    });
});
