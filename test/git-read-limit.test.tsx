import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIT_READ_LIMIT, GitDidNotAnswer, gitFileStatus, gitLogSince, gitShowHead, gitTreeStatus } from '../src/main/git-ports.js';
import { repoDiff, repoStatus } from '../src/main/repo-git.js';
import { GitReadProblem } from '../src/renderer/components/GitReadProblem.js';

/**
 * A GIT READ THAT DOES NOT ANSWER IS SAID, NOT SHOWN AS NOTHING. A read has a limit a slow real repository won't reach; one that reaches it is a failure the person sees, with a Retry, and never an empty list that reads as "nothing changed". A real git, whose configured hook never exits.
 */
let root: string;
let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const savedLimit = GIT_READ_LIMIT.ms;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'git-limit-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
});
afterEach(async () => {
    GIT_READ_LIMIT.ms = savedLimit;
    // The promise form: it retries a busy folder (the hook's child, which the limit does not end, still has it open). rmSync's retries do not cover EBUSY on a directory.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe('the limit', () => {
    it('is one a slow real repository will not reach', () => {
        expect(GIT_READ_LIMIT.ms).toBeGreaterThanOrEqual(120_000);
    });

    it('a read within it answers as ever', async () => {
        expect(await gitTreeStatus(repo)).toMatchObject({ 'a.txt': 'modified' });
        expect(await gitFileStatus(repo, 'a.txt')).toBe('modified');
        expect(await gitShowHead(repo, 'a.txt')).toBe('one\n');
        expect((await gitLogSince(repo, 0)).map((c) => c.subject)).toEqual(['first']);
    });

    it('a folder that is no repository is still nothing to show, not a failure', async () => {
        const plain = join(root, 'plain');
        mkdirSync(plain);
        expect(await gitTreeStatus(plain)).toEqual({});
        expect(await gitLogSince(plain, 0)).toEqual([]);
    });
});

describe('past it, what the read started is ended', () => {
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
    let mark: string;
    let child = 0;

    beforeEach(() => {
        mark = join(root, 'child.pid');
        child = 0;
        // Its own real pid on every system, its folder the repository's. It ends itself in time, so a red run leaves nothing behind.
        const script = join(root, 'child.cjs');
        writeFileSync(script, 'require("fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 90000);\n');
        const hook = join(root, 'starts-a-child.sh');
        const slashes = (p: string) => p.replace(/\\/g, '/');
        writeFileSync(hook, `#!/bin/sh\n"${slashes(process.execPath)}" "${slashes(script)}" "${slashes(mark)}"\n`);
        chmodSync(hook, 0o755);
        git('config', 'core.fsmonitor', slashes(hook));
        GIT_READ_LIMIT.ms = 6000;
    });
    afterEach(() => { if (child !== 0 && alive(child)) process.kill(child); });

    it.each([
        ['gitTreeStatus', () => gitTreeStatus(repo).then(() => 'answered', (error: Error) => error.message)],
        ['repoStatus', () => repoStatus(repo, '.').then((r) => (r.ok ? 'answered' : r.error))],
    ])('%s: the hook\'s child is running at the limit, is gone after it, and the folder can be removed', async (_name, read) => {
        const reading = read();
        await vi.waitFor(() => { expect(existsSync(mark) && readFileSync(mark, 'utf8') !== '').toBe(true); }, { timeout: 5500, interval: 50 });
        child = Number(readFileSync(mark, 'utf8'));
        expect(alive(child)).toBe(true);
        expect(await reading).toMatch(/did not answer/);
        await vi.waitFor(() => { expect(alive(child)).toBe(false); }, { timeout: 40_000, interval: 200 });
        await vi.waitFor(() => { rmSync(repo, { recursive: true, force: true }); expect(existsSync(repo)).toBe(false); }, { timeout: 5000, interval: 200 });
    }, 70_000);
});

describe('past it', () => {
    beforeEach(() => {
        const hook = join(root, 'never.sh');
        writeFileSync(hook, '#!/bin/sh\nsleep 30\n');
        chmodSync(hook, 0o755);
        git('config', 'core.fsmonitor', hook.replace(/\\/g, '/'));
        GIT_READ_LIMIT.ms = 500;
    });

    it('gitTreeStatus fails, in words, and not as an empty list', async () => {
        await expect(gitTreeStatus(repo)).rejects.toBeInstanceOf(GitDidNotAnswer);
        await expect(gitTreeStatus(repo)).rejects.toThrow(/did not answer/);
    });

    it('gitFileStatus: the same', async () => { await expect(gitFileStatus(repo, 'a.txt')).rejects.toBeInstanceOf(GitDidNotAnswer); });

    it('repoStatus says so, as its own failure', async () => {
        const r = await repoStatus(repo, '.');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/did not answer/);
    });

    it('repoDiff says so too', async () => {
        const r = await repoDiff(repo, '.', 'a.txt', false);
        expect(r.ok).toBe(false);
    }, 15_000);
});

describe('what a person sees', () => {
    it('the words, and a Retry that is a real button', () => {
        const html = renderToStaticMarkup(<GitReadProblem reason="git did not answer within 2 minutes" onRetry={() => {}} />);
        expect(html).toContain('git did not answer within 2 minutes');
        expect(html).toMatch(/<button[^>]*data-git-read-retry/);
    });

    it('the Files panel and an agent\'s commits both show it, and neither swallows the failure', () => {
        const files = readFileSync('src/renderer/components/FilesPanelContainer.tsx', 'utf8');
        expect(files).toContain('<GitReadProblem');
        expect(files).not.toMatch(/gitStatus\(workspace\.id\)\.then\(setGit, \(\) => \{\}\)/);
        const agent = readFileSync('src/renderer/components/AgentView.tsx', 'utf8');
        expect(agent).toContain('<GitReadProblem');
        expect(readFileSync('src/renderer/App.tsx', 'utf8')).not.toMatch(/commitsSince\(workspaceId, since\)\.then\(\(r\) => \(r\.ok \? r\.commits : \[\]\)\)/);
    });
});
