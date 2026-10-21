import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoCommit, repoCreateBranch, repoDiff, repoPull, repoPush, repoStage, repoStatus, repoUnstage } from '../src/main/repo-git.js';

/**
 * THE REPOSITORY PANEL'S GIT (beta.33 item 14; Genie 1 main/repo/index.ts — the Repository official plugin's engine). Every
 * action is the person's own click, run with the real git on the host that holds the workspace, the repo path confined to
 * the workspace. Measured here against a REAL git with a directory as the remote: status, diff, stage, unstage, commit,
 * branch, push, pull (fast-forward only — never a surprise merge). Failures come back in git's own words.
 */

const run = promisify(execFile);
const ID = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t'];
let dir: string;
let ws: string;
let origin: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-repo-git-'));
    origin = join(dir, 'origin.git');
    ws = join(dir, 'ws');
    await run('git', ['init', '--bare', '--quiet', '--initial-branch=main', origin]);
    await run('git', ['init', '--quiet', '--initial-branch=main', ws]);
    await run('git', ['-C', ws, 'config', 'user.email', 't@example.invalid']);
    await run('git', ['-C', ws, 'config', 'user.name', 't']);
    // The fixture's line endings are the fixture's, not the machine's: a Windows runner's global `core.autocrlf=true`
    // checked `b.txt` out as "from elsewhere\r\n" and failed beta.35's Windows release job (genie#1101).
    await run('git', ['-C', ws, 'config', 'core.autocrlf', 'false']);
    await writeFile(join(ws, 'a.txt'), 'one\n');
    await run('git', ['-C', ws, 'add', 'a.txt']);
    await run('git', ['-C', ws, ...ID, 'commit', '--quiet', '-m', 'first']);
    await run('git', ['-C', ws, 'remote', 'add', 'origin', origin]);
    await run('git', ['-C', ws, 'push', '--quiet', '-u', 'origin', 'main']);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the repository panel\'s git, against a real git', () => {
    it('status names the branch, its upstream, and each change on its staged / unstaged side', async () => {
        await writeFile(join(ws, 'a.txt'), 'two\n');
        await writeFile(join(ws, 'new.txt'), 'n\n');
        const s = await repoStatus(ws, '');
        expect(s).toMatchObject({ ok: true, value: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 } });
        const changes = (s as { value: { changes: { path: string; label: string; staged: boolean; unstaged: boolean }[] } }).value.changes;
        expect(changes).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'a.txt', label: 'modified', staged: false, unstaged: true }),
            expect.objectContaining({ path: 'new.txt', label: 'untracked' }),
        ]));
    });

    it('diff shows the change; stage moves it to the staged side; unstage moves it back', async () => {
        await writeFile(join(ws, 'a.txt'), 'two\n');
        const d = await repoDiff(ws, '', 'a.txt', false);
        expect(d).toMatchObject({ ok: true });
        expect((d as { value: { patch: string } }).value.patch).toMatch(/-one\n\+two/);
        expect(await repoStage(ws, '', ['a.txt'])).toEqual({ ok: true, value: null });
        expect(((await repoStatus(ws, '')) as { value: { changes: { staged: boolean }[] } }).value.changes[0]!.staged).toBe(true);
        expect((await repoDiff(ws, '', 'a.txt', true) as { value: { patch: string } }).value.patch).toMatch(/\+two/);
        expect(await repoUnstage(ws, '', ['a.txt'])).toEqual({ ok: true, value: null });
        expect(((await repoStatus(ws, '')) as { value: { changes: { staged: boolean }[] } }).value.changes[0]!.staged).toBe(false);
    });

    it('commit, then push: the remote has it; an empty message is refused before git runs', async () => {
        await writeFile(join(ws, 'a.txt'), 'two\n');
        await repoStage(ws, '', ['a.txt']);
        expect(await repoCommit(ws, '', '   ')).toEqual({ ok: false, error: 'A commit message is required.' });
        expect(await repoCommit(ws, '', 'second')).toMatchObject({ ok: true });
        expect(((await repoStatus(ws, '')) as { value: { ahead: number } }).value.ahead).toBe(1);
        expect(await repoPush(ws, '', 'origin')).toEqual({ ok: true, value: null });
        const { stdout } = await run('git', ['--git-dir', origin, 'log', '--format=%s', '-1', 'main']);
        expect(stdout.trim()).toBe('second');
    });

    it('a new branch is created and switched to; pull fast-forwards a change made elsewhere', async () => {
        const other = join(dir, 'other');
        await run('git', ['clone', '--quiet', '-c', 'core.autocrlf=false', origin, other]);
        await writeFile(join(other, 'b.txt'), 'from elsewhere\n');
        await run('git', ['-C', other, 'add', 'b.txt']);
        await run('git', ['-C', other, ...ID, 'commit', '--quiet', '-m', 'elsewhere']);
        await run('git', ['-C', other, 'push', '--quiet', 'origin', 'main']);
        expect(await repoPull(ws, '')).toEqual({ ok: true, value: null });
        expect(await readFile(join(ws, 'b.txt'), 'utf8')).toBe('from elsewhere\n');
        expect(await repoCreateBranch(ws, '', 'feat/x')).toEqual({ ok: true, value: null });
        expect(((await repoStatus(ws, '')) as { value: { branch: string } }).value.branch).toBe('feat/x');
        expect(await repoCreateBranch(ws, '', '')).toEqual({ ok: false, error: 'A branch name is required.' });
    });

    it('a repo path outside the workspace is refused before git runs; git\'s own failure comes back in its words', async () => {
        expect(await repoStatus(ws, '../..')).toMatchObject({ ok: false, error: expect.stringMatching(/escapes the workspace root/) });
        const r = await repoPush(ws, '', 'nowhere');
        expect(r).toMatchObject({ ok: false });
        expect((r as { error: string }).error).toMatch(/nowhere/);
    });
});
