import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
afterEach(() => {
    GIT_READ_LIMIT.ms = savedLimit;
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
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
